"""Pure packaging metadata tests; never builds an archive or touches an installation."""
import importlib.util, json
from pathlib import Path
import sys
import tempfile
import unittest

MODULE_PATH = Path(__file__).with_name("package-editions.py")
SPEC = importlib.util.spec_from_file_location("package_editions_notes_test", MODULE_PATH)
PACKAGE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = PACKAGE
SPEC.loader.exec_module(PACKAGE)


class ReleaseNotesTests(unittest.TestCase):
    def test_utf8_notes_preserve_text_without_fetching_or_rendering_markup(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            (base / "docs").mkdir()
            notes = "更新说明\r\n<script>text only</script>\nhttps://example.invalid/notes"
            (base / "docs/UPDATE-NOTES.md").write_bytes(notes.encode("utf-8"))
            self.assertEqual(PACKAGE.read_release_notes(base), notes.replace("\r\n", "\n"))

    def test_missing_invalid_oversized_and_control_character_notes_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            (base / "docs").mkdir()
            with self.assertRaises(PACKAGE.PackagingError):
                PACKAGE.read_release_notes(base)
            for content in [b"\xff\xfe", b"x" * 48001, b"x" * 12001, "😀".encode("utf-8") * 6001, b"null\x00", b"escape\x1b"]:
                with self.subTest(content_size=len(content)):
                    (base / "docs/UPDATE-NOTES.md").write_bytes(content)
                    with self.assertRaises(PACKAGE.PackagingError):
                        PACKAGE.read_release_notes(base)

    def test_all_edition_notes_are_scoped_and_state_the_current_version(self):
        for edition in PACKAGE.EDITIONS:
            with self.subTest(edition=edition):
                notes = PACKAGE.read_release_notes(PACKAGE.ROOT / "editions" / edition)
                version = json.loads((PACKAGE.ROOT / "editions" / edition / "edition.json").read_text(encoding="utf-8"))["version"]
                self.assertIn(version, notes)
                self.assertIn("每 6 小时", notes)
                self.assertIn("本版本不再提示", notes)


if __name__ == "__main__":
    unittest.main()
