#!/usr/bin/env python3
"""
SkiffCode terminal host: runs one command in a pseudo-terminal and serves it on a
Unix socket. It outlives the SkiffCode server (so Claude keeps running across
server restarts and page reloads), remembers recent output so a reconnecting
client sees the scrollback, and lets any number of clients attach.

Usage: ptyhost.py SOCKET COLS ROWS CWD -- COMMAND [ARGS...]

Protocol (both directions): 1-byte type, 4-byte big-endian length, payload.
  client -> host:  i = input bytes, r = resize "cols,rows", k = kill (SIGHUP the child)
  host -> client:  h = history (sent once on connect), o = output, x = exited "code"
"""
import errno
import fcntl
import os
import pty
import selectors
import signal
import socket
import struct
import sys
import termios
import time

HISTORY_LIMIT = 4 * 1024 * 1024  # bytes of scrollback kept for reconnecting clients
SAVE_EVERY = 4.0  # seconds between scrollback saves (survives reboots)


def frame(kind, payload):
    return kind + struct.pack(">I", len(payload)) + payload


def set_size(fd, cols, rows):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except OSError:
        pass


def main():
    sep = sys.argv.index("--")
    sock_path, cols, rows, cwd = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
    cmd = sys.argv[sep + 1:]

    log_path = os.environ.pop("SKIFFCODE_PTY_LOG", "")
    preload_path = os.environ.pop("SKIFFCODE_PTY_PRELOAD", "")
    preload = b""
    if preload_path:
        try:
            with open(preload_path, "rb") as f:
                preload = f.read()[-HISTORY_LIMIT // 2:]
            if preload:
                preload += b"\r\n\x1b[2m\xe2\x94\x80\xe2\x94\x80 restarted \xe2\x94\x80\xe2\x94\x80\x1b[0m\r\n\r\n"
        except OSError:
            preload = b""

    pid, master = pty.fork()
    if pid == 0:
        try:
            os.chdir(cwd)
        except OSError:
            pass
        os.environ["TERM"] = os.environ.get("SKIFFCODE_TERM", "xterm-256color")
        os.environ["COLORTERM"] = "truecolor"
        try:
            os.execvp(cmd[0], cmd)
        except OSError as e:
            sys.stderr.write("skiffcode: cannot run %s: %s\r\n" % (cmd[0], e))
            os._exit(127)

    set_size(master, cols, rows)
    fl = fcntl.fcntl(master, fcntl.F_GETFL)
    fcntl.fcntl(master, fcntl.F_SETFL, fl | os.O_NONBLOCK)

    try:
        os.unlink(sock_path)
    except FileNotFoundError:
        pass
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(sock_path)
    os.chmod(sock_path, 0o600)
    srv.listen(8)
    srv.setblocking(False)

    # Write our pid next to the socket so the server can find/kill us.
    with open(sock_path + ".pid", "w") as f:
        f.write("%d %d\n" % (os.getpid(), pid))

    sel = selectors.DefaultSelector()
    sel.register(master, selectors.EVENT_READ, "pty")
    sel.register(srv, selectors.EVENT_READ, "accept")
    clients = {}  # sock -> receive buffer
    history = bytearray(preload)
    exit_code = None
    state = {"dirty": False, "saved": time.monotonic()}

    def save_history(force=False):
        if not log_path or not (state["dirty"] or force):
            return
        tmp = log_path + ".tmp"
        try:
            with open(tmp, "wb") as f:
                f.write(bytes(history))
            os.replace(tmp, log_path)
            state["dirty"] = False
            state["saved"] = time.monotonic()
        except OSError:
            pass

    def broadcast(data):
        for c in list(clients):
            try:
                c.sendall(data)
            except OSError:
                drop(c)

    def drop(c):
        try:
            sel.unregister(c)
        except Exception:
            pass
        clients.pop(c, None)
        try:
            c.close()
        except OSError:
            pass

    def trim_history():
        if len(history) > HISTORY_LIMIT:
            cut = len(history) - HISTORY_LIMIT
            nl = history.find(b"\n", cut)
            del history[: (nl + 1 if 0 <= nl < cut + 65536 else cut)]

    def handle(c, kind, payload):
        if kind == b"i":
            try:
                os.write(master, payload)
            except OSError:
                pass
        elif kind == b"r":
            try:
                c_, r_ = payload.decode().split(",")
                set_size(master, max(2, int(c_)), max(2, int(r_)))
                os.kill(pid, signal.SIGWINCH)
            except (ValueError, OSError):
                pass
        elif kind == b"k":
            try:
                os.killpg(os.getpgid(pid), signal.SIGHUP)
            except OSError:
                pass

    def on_term(*_):
        # Stop the program; the normal exit path then saves the scrollback.
        try:
            os.killpg(os.getpgid(pid), signal.SIGHUP)
        except OSError:
            pass

    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    signal.signal(signal.SIGPIPE, signal.SIG_IGN)
    signal.signal(signal.SIGTERM, on_term)

    while True:
        for key, _ in sel.select(timeout=1.0):
            tag = key.data
            if tag == "pty":
                try:
                    data = os.read(master, 65536)
                except OSError as e:
                    if e.errno in (errno.EAGAIN, errno.EINTR):
                        continue
                    data = b""
                if not data:
                    sel.unregister(master)
                    _, status = os.waitpid(pid, 0)
                    exit_code = os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else status >> 8
                    broadcast(frame(b"x", str(exit_code).encode()))
                    break
                history.extend(data)
                trim_history()
                state["dirty"] = True
                broadcast(frame(b"o", data))
            elif tag == "accept":
                try:
                    c, _ = srv.accept()
                except OSError:
                    continue
                c.settimeout(10)  # slow clients get 10 s before being dropped
                try:
                    c.sendall(frame(b"h", bytes(history)))
                except OSError:
                    c.close()
                    continue
                clients[c] = bytearray()
                sel.register(c, selectors.EVENT_READ, "client")
            else:
                c = key.fileobj
                try:
                    data = c.recv(65536)
                except (BlockingIOError, socket.timeout):
                    continue
                except OSError:
                    data = b""
                if not data:
                    drop(c)
                    continue
                buf = clients[c]
                buf.extend(data)
                while len(buf) >= 5:
                    (n,) = struct.unpack(">I", bytes(buf[1:5]))
                    if len(buf) < 5 + n:
                        break
                    kind, payload = bytes(buf[0:1]), bytes(buf[5:5 + n])
                    del buf[: 5 + n]
                    handle(c, kind, payload)
        if exit_code is not None:
            break
        if state["dirty"] and time.monotonic() - state["saved"] >= SAVE_EVERY:
            save_history()

    save_history(force=True)
    # Give clients a moment to read the exit frame, then clean up.
    time.sleep(0.2)
    for c in list(clients):
        drop(c)
    srv.close()
    # Only clean up files that are still ours (a new host may already use this path).
    try:
        with open(sock_path + ".pid") as f:
            mine = f.read().split()[0] == str(os.getpid())
    except (OSError, IndexError):
        mine = False
    if mine:
        for p in (sock_path, sock_path + ".pid"):
            try:
                os.unlink(p)
            except OSError:
                pass
        with open(sock_path + ".exit", "w") as f:
            f.write("%s\n" % exit_code)


if __name__ == "__main__":
    main()
