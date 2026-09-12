from evoflow.observability.poll_loop_log import log_poll_loop_start, log_poll_tick, reset_poll_loop_log_cache


def test_poll_loop_log_throttles_ticks() -> None:
    reset_poll_loop_log_cache()
    log_poll_loop_start("test_loop", key="a")
    log_poll_tick("test_loop", key="a", interval_s=60.0)
    log_poll_tick("test_loop", key="a", interval_s=60.0)
    reset_poll_loop_log_cache()
