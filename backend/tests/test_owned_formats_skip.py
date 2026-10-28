"""owned KB folder import skip rules."""

from evoflow.knowledge.owned.formats import (
    folder_path_has_skipped_dir,
    is_supported_file,
    should_skip_dir,
    should_skip_file,
)


def test_supported_extensions():
    assert is_supported_file("note.md")
    assert is_supported_file("deck.PPTX")
    assert not is_supported_file("asset.zip")
    assert not is_supported_file("photo.png")
    assert not is_supported_file("main.py")
    assert not is_supported_file("app.ts")


def test_skip_archives_images_and_code():
    assert should_skip_file("精品人物资产大全.zip")
    assert should_skip_file("Ai漫剧工具包/资料/精品人物资产大全.zip")
    assert should_skip_file("pack.gz")
    assert should_skip_file("a.7z")
    assert should_skip_file("hero.png")
    assert should_skip_file("shot.JPEG")
    assert should_skip_file("main.py")
    assert should_skip_file("index.ts")
    assert should_skip_file("App.tsx")


def test_skip_dotfiles_and_hidden():
    assert should_skip_file(".DS_Store")
    assert should_skip_file(".gitignore")
    assert should_skip_file(".hidden.md")
    assert should_skip_dir(".git")
    assert should_skip_dir(".obsidian")
    assert should_skip_dir(".cursor")
    assert should_skip_dir(".vscode")
    assert folder_path_has_skipped_dir(".obsidian")
    assert folder_path_has_skipped_dir("docs/.git/hooks")
    assert folder_path_has_skipped_dir("src/node_modules/pkg")
    assert not folder_path_has_skipped_dir("docs/guides")
    assert not folder_path_has_skipped_dir("")


def test_skip_temp_and_lock_files():
    assert should_skip_file("Thumbs.db")
    assert should_skip_file("desktop.ini")
    assert should_skip_file("~$Book.xlsx")
    assert should_skip_file("note.tmp")
    assert should_skip_file("draft.swp")
    assert should_skip_file("file~")


def test_keep_normal_docs():
    assert not should_skip_file("readme.md")
    assert not should_skip_file("手册.pdf")
    assert not should_skip_file("data.csv")
    assert not should_skip_file("notes.json")
