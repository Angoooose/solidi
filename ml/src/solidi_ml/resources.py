"""Fit the work to the machine: how many helper processes to start, which device to use, and how
to tell that memory ran out so the work can shrink instead of stopping."""

from __future__ import annotations

import gc
import os
import platform

import psutil
import torch

RESERVE_GB = 4.0       # memory left alone for the system and the main process
MAX_WORKERS = 12
GPU_SHARE = 0.9        # of the graphics card's memory; the rest is left for the desktop


def pick_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def workers(requested: int | None = None, heavy: bool = True) -> int:
    """How many helper processes to start, from the processor cores and the memory free right now.

    `heavy` helpers load PyTorch. On Windows each one is a fresh process that loads its own copy
    (a few gigabytes with the GPU libraries); elsewhere they share the parent's. Light helpers
    only open and cut pictures. Zero means the main process does the work itself."""
    if requested is not None:
        return requested
    cores = psutil.cpu_count(logical=False) or os.cpu_count() or 2
    free = psutil.virtual_memory().available / 2**30
    each = 0.4 if not heavy else 3.0 if platform.system() == "Windows" else 1.0
    return int(max(0, min(cores - 1, (free - RESERVE_GB) / each, MAX_WORKERS)))


def cap_gpu_memory(device: str) -> None:
    """Make PyTorch stop at 90% of the graphics card's own memory and raise an out-of-memory
    error there. Without this, the Windows NVIDIA driver quietly spills into ordinary system
    memory instead: nothing fails, but the work runs up to a hundred times slower, and the code
    that shrinks the batch never hears about it."""
    if device == "cuda":
        torch.cuda.set_per_process_memory_fraction(GPU_SHARE)


def is_out_of_memory(error: BaseException) -> bool:
    """True for the errors a full graphics card or full system memory raises."""
    if isinstance(error, (torch.OutOfMemoryError, MemoryError)):
        return True
    return isinstance(error, RuntimeError) and "out of memory" in str(error).lower()


def release() -> None:
    """Give back memory that is no longer referenced, before trying again with less."""
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
