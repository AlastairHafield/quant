from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np


@dataclass
class Match:
    name: str
    score: float
    x: int  # centre, in full-frame pixels
    y: int
    w: int
    h: int
    found: bool


def to_gray(img):
    if img.ndim == 2:
        return img
    if img.shape[2] == 4:
        return cv2.cvtColor(img, cv2.COLOR_BGRA2GRAY)
    return cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)


class Matcher:
    def __init__(self, specs, templates_dir=None, images=None):
        """specs: name -> TemplateSpec. images: optional name -> ndarray (for tests)."""
        self.specs = specs
        self.templates = {}
        for name, spec in specs.items():
            if images and name in images:
                img = images[name]
            else:
                p = Path(templates_dir) / spec.file
                img = cv2.imread(str(p), cv2.IMREAD_COLOR)
                if img is None:
                    raise FileNotFoundError(f"template '{name}' not found at {p}")
            self.templates[name] = to_gray(img)

    def has(self, name):
        return name in self.templates

    def find(self, name, frame):
        spec = self.specs[name]
        tmpl = self.templates[name]
        gray = to_gray(frame)
        fh, fw = gray.shape
        ox, oy = 0, 0
        if spec.region:
            x0, y0, x1, y1 = spec.region
            ox, oy = int(x0 * fw), int(y0 * fh)
            gray = gray[oy:int(y1 * fh), ox:int(x1 * fw)]

        best = Match(name, -1.0, 0, 0, 0, 0, False)
        for s in spec.scales:
            t = tmpl if s == 1.0 else cv2.resize(tmpl, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
            th, tw = t.shape
            if th > gray.shape[0] or tw > gray.shape[1] or th < 4 or tw < 4:
                continue
            res = cv2.matchTemplate(gray, t, cv2.TM_CCOEFF_NORMED)
            _, score, _, loc = cv2.minMaxLoc(res)
            if not np.isfinite(score):
                continue
            if score > best.score:
                best = Match(name, float(score), ox + loc[0] + tw // 2, oy + loc[1] + th // 2, tw, th, False)
        best.found = best.score >= spec.threshold
        return best
