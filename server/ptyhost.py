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
CLIENT_BACKLOG = HISTORY_LIMIT + 4 * 1024 * 1024  # output queued for a client that doesn't read; past this it is dropped
MAX_FRAME = 64 * 1024 * 1024  # largest frame a client may send


def frame(kind, payload):
    return kind + struct.pack(">I", len(payload)) + payload


def set_size(fd, cols, rows):
    cols, rows = (min(65535, max(1, n)) for n in (cols, rows))  # the sizes are 16-bit
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except OSError:
        pass


def clean_cut(buf, cut):
    """Where to cut the first `cut` bytes off: after the next newline if one is near, else not inside a UTF-8 character."""
    nl = buf.find(b"\n", cut, cut + 65536)
    if nl != -1:
        return nl + 1
    while cut < len(buf) and buf[cut] & 0xC0 == 0x80:
        cut += 1
    return cut


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
                preload = f.read()
            preload = preload[clean_cut(preload, max(0, len(preload) - HISTORY_LIMIT // 2)):]
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
        os.environ["TERM"] = "xterm-256color"
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
    clients = {}  # sock -> {"rx": received bytes, "tx": output not yet sent}
    pending = bytearray()  # input the program hasn't taken yet (the pty is non-blocking)
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

    def watch(c):
        events = selectors.EVENT_READ | (selectors.EVENT_WRITE if clients[c]["tx"] else 0)
        if sel.get_key(c).events != events:
            sel.modify(c, events, "client")

    def flush(c):
        tx = clients[c]["tx"]
        try:
            n = c.send(tx)
        except (BlockingIOError, InterruptedError):
            n = 0
        except OSError:
            drop(c)
            return
        del tx[:n]
        watch(c)

    def send(c, data):
        st = clients.get(c)
        if st is None:
            return
        st["tx"].extend(data)
        if len(st["tx"]) > CLIENT_BACKLOG:
            drop(c)  # it stopped reading; it can reconnect for the history
            return
        flush(c)

    def broadcast(data):
        for c in list(clients):
            send(c, data)

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
            del history[: clean_cut(history, len(history) - HISTORY_LIMIT)]

    def write_input():
        try:
            n = os.write(master, pending)
        except (BlockingIOError, InterruptedError):
            n = 0
        except OSError:
            n = len(pending)
        del pending[:n]
        try:
            sel.modify(master, selectors.EVENT_READ | (selectors.EVENT_WRITE if pending else 0), "pty")
        except (KeyError, ValueError):
            pass  # the program has exited

    def handle(c, kind, payload):
        if kind == b"i":
            pending.extend(payload)
            write_input()
        elif kind == b"r":
            try:
                c_, r_ = payload.decode().split(",")
                set_size(master, int(c_), int(r_))
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
        for key, mask in sel.select(timeout=1.0):
            tag = key.data
            if tag == "pty" and mask & selectors.EVENT_WRITE:
                write_input()
            if tag == "pty" and mask & selectors.EVENT_READ:
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
                c.setblocking(False)
                clients[c] = {"rx": bytearray(), "tx": bytearray()}
                sel.register(c, selectors.EVENT_READ, "client")
                send(c, frame(b"h", bytes(history)))
            elif tag == "client":
                c = key.fileobj
                if mask & selectors.EVENT_WRITE and c in clients:
                    flush(c)
                if not (mask & selectors.EVENT_READ) or c not in clients:
                    continue
                try:
                    data = c.recv(65536)
                except (BlockingIOError, InterruptedError):
                    continue
                except OSError:
                    data = b""
                if not data:
                    drop(c)
                    continue
                buf = clients[c]["rx"]
                buf.extend(data)
                while len(buf) >= 5:
                    (n,) = struct.unpack(">I", bytes(buf[1:5]))
                    if n > MAX_FRAME:
                        drop(c)
                        break
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
    # Give clients a moment to read what is still queued and the exit frame, then clean up.
    for c, st in list(clients.items()):
        if st["tx"]:
            try:
                c.settimeout(1.0)
                c.sendall(st["tx"])
            except OSError:
                pass
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
