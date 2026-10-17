import random
import unittest

from create_apk_delta import apply_delta, create_delta


class ApkDeltaTests(unittest.TestCase):
    def test_patch_reconstructs_data_after_insertions_and_edits(self):
        random.seed(19)
        base = bytes(random.randrange(256) for _ in range(250_000))
        changed = base[:74_321] + b"new release payload" * 280 + base[74_321:]
        changed = changed[:190_000] + b"changed block" * 125 + changed[190_000:]
        patch = create_delta(base, changed)
        self.assertEqual(apply_delta(base, patch), changed)
        self.assertLess(len(patch), len(changed))

    def test_empty_and_completely_different_content(self):
        base = b""
        target = b"different" * 10_000
        patch = create_delta(base, target)
        self.assertEqual(apply_delta(base, patch), target)

    def test_rejects_wrong_base_or_corrupt_patch(self):
        base = b"A" * 50_000
        target = b"A" * 49_000 + b"B" * 1_000
        patch = create_delta(base, target)
        with self.assertRaises((ValueError, OSError)):
            apply_delta(b"wrong base", patch[:-6] + b"broken")
        with self.assertRaises(ValueError):
            apply_delta(base, b"not a valid patch")


if __name__ == "__main__":
    unittest.main()
