"""跨进程文件锁与原子写.

是什么: try_flock 在指定文件上非阻塞地取 ``fcntl.flock`` 排他锁; atomic_write_bytes
先在目标同目录写临时文件, 再 ``os.replace`` 到目标路径.
为什么: 底图(base)与交付物(final)都可能叠加两个进程的读写. 只写临时文件再 replace,
读者要么看到旧的完整文件、要么看到新的完整文件, 不会读到缺字符/缺 labels 的中间态(C7);
flock 只覆盖 replace 与 compose 的数秒窗口, 绘制阶段不持锁.
元信息: 2026-10, mapdoc 垂直切片.
"""

from __future__ import annotations

import contextlib
import fcntl
import os
import tempfile
from collections.abc import Iterator
from pathlib import Path


@contextlib.contextmanager
def try_flock(path: Path) -> Iterator[bool]:
    """在 path 上非阻塞取排他 flock.

    产出 True 表示取到锁, False 表示被别的进程/线程占用. 退出上下文时关闭文件描述符,
    关闭即释放锁, 因此调用方不需要显式 LOCK_UN.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = open(path, "a+b")
    try:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            acquired = False
        else:
            acquired = True
        yield acquired
    finally:
        handle.close()


def atomic_write_bytes(path: Path, data: bytes) -> None:
    """把 data 原子写入 path: 同目录临时文件写满 fsync 后 os.replace.

    临时文件放在目标同目录, 保证 replace 不跨文件系统; 名称带随机后缀,
    多个线程同时写同一目标时不会互相覆盖半成品.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(
        dir=path.parent, prefix=path.name + ".", suffix=".tmp"
    )
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(temporary)
        raise
