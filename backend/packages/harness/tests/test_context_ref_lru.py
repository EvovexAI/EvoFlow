from evoflow.config.tool_results_config import ToolResultsConfig, set_tool_results_config
from evoflow.context.context_ref_lru import list_refs, refs_footer, register_ref


def test_context_ref_lru_eviction_and_footer():
    set_tool_results_config(ToolResultsConfig(ref_lru_enabled=True, ref_lru_max_chars=5000, threshold_chars=1000))
    tid = "thread-lru-test"
    register_ref(tid, "/tmp/a.txt", 3000)
    register_ref(tid, "/tmp/b.txt", 3000)
    paths = list_refs(tid)
    assert len(paths) == 1
    assert paths[0] == "/tmp/b.txt"
    footer = refs_footer(tid)
    assert "<context_refs>" in footer
    assert "/tmp/b.txt" in footer
