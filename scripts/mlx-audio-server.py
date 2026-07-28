#!/usr/bin/env python3
"""Run MLX-Audio with a Metal stream owned by its inference worker thread.

MLX streams are thread-local. MLX-Audio 0.4.6 preloads models in an
``asyncio.to_thread`` worker, then performs inference on a different broker
thread without first creating that thread's stream. Whisper then fails at
``mx.async_eval`` with ``There is no Stream(gpu, 0) in current thread``. Keep
this compatibility shim local and remove it once upstream owns model loading
and stream creation inside the broker thread.
"""

from __future__ import annotations

import mlx.core as mx
from mlx_audio.server_inference import InferenceBroker


_original_run = InferenceBroker._run


def _run_with_thread_local_stream(broker: InferenceBroker) -> None:
    worker_stream = mx.new_stream(mx.default_device())
    mx.set_default_stream(worker_stream)
    _original_run(broker)


InferenceBroker._run = _run_with_thread_local_stream

import mlx_audio.server as mlx_server  # noqa: E402


async def _load_model_in_broker_thread(_model_name: str) -> None:
    """Defer the cached model load to the serialized inference worker."""


mlx_server._preflight_model_load = _load_model_in_broker_thread


if __name__ == "__main__":
    mlx_server.main()
