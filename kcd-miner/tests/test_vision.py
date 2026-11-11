import numpy as np

from kcd_miner.config import TemplateSpec
from kcd_miner.vision import Matcher


def make_template(seed=0, size=(30, 40)):
    rng = np.random.default_rng(seed)
    return rng.integers(0, 255, size=(*size, 3), dtype=np.uint8)


def frame_with(tmpl, at=None, shape=(400, 600)):
    rng = np.random.default_rng(99)
    f = (rng.integers(0, 40, size=(*shape, 3))).astype(np.uint8)
    if at is not None:
        x, y = at
        h, w = tmpl.shape[:2]
        f[y:y + h, x:x + w] = tmpl
    return f


def test_finds_template_centre():
    t = make_template()
    m = Matcher({"p": TemplateSpec("p.png", 0.8)}, images={"p": t})
    r = m.find("p", frame_with(t, at=(100, 200)))
    assert r.found and r.score > 0.95
    assert (r.x, r.y) == (100 + 20, 200 + 15)


def test_absent_template_not_found():
    t = make_template()
    m = Matcher({"p": TemplateSpec("p.png", 0.8)}, images={"p": t})
    assert not m.find("p", frame_with(t, at=None)).found


def test_region_restricts_search_and_offsets_coords():
    t = make_template()
    spec = TemplateSpec("p.png", 0.8, region=[0.5, 0.5, 1.0, 1.0])
    m = Matcher({"p": spec}, images={"p": t})
    assert not m.find("p", frame_with(t, at=(10, 10))).found  # outside region
    r = m.find("p", frame_with(t, at=(400, 300)))
    assert r.found and (r.x, r.y) == (420, 315)


def test_multiscale_matches_smaller_instance():
    import cv2
    t = make_template(size=(60, 80))
    small = cv2.resize(t, None, fx=0.5, fy=0.5, interpolation=cv2.INTER_AREA)
    m = Matcher({"n": TemplateSpec("n.png", 0.7, scales=[0.5, 1.0])}, images={"n": t})
    assert m.find("n", frame_with(small, at=(300, 100))).found
