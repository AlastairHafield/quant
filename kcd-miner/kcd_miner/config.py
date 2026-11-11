import json
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class TemplateSpec:
    file: str
    threshold: float = 0.8
    # Search region as fractions of the frame: [x0, y0, x1, y1]. None = whole frame.
    region: list | None = None
    # Scales to try; nodes change apparent size with distance, prompts usually don't.
    scales: list = field(default_factory=lambda: [1.0])


@dataclass
class Config:
    window_title: str = "Kingdom Come"
    monitor: int = 1
    templates_dir: str = "templates"
    templates: dict = field(default_factory=dict)  # name -> TemplateSpec
    abort_on: list = field(default_factory=list)  # template names that stop the bot
    keys: dict = field(default_factory=lambda: {"forward": "w"})
    mine_action: dict = field(default_factory=lambda: {
        "type": "hold_key", "key": "e", "hold_s": 4.0, "max_cycles": 10, "after_s": 0.6,
    })
    scan: dict = field(default_factory=lambda: {
        "enabled": True, "step_px": 250, "steps_per_rotation": 16, "settle_s": 0.35,
    })
    approach: dict = field(default_factory=lambda: {
        "center_tolerance_px": 40, "turn_gain": 0.5, "step_s": 0.4, "timeout_s": 20,
    })
    respawn_wait_s: float = 60.0
    jitter: float = 0.15
    max_runtime_min: float = 120.0
    breaks: dict = field(default_factory=lambda: {"every_min": [25, 45], "duration_min": [2, 6]})
    hotkeys: dict = field(default_factory=lambda: {"pause": "f8", "quit": "f9"})
    require_focus: bool = True

    @classmethod
    def load(cls, path):
        path = Path(path)
        raw = json.loads(path.read_text())
        raw["templates"] = {k: TemplateSpec(**v) for k, v in raw.get("templates", {}).items()}
        cfg = cls(**raw)
        # Resolve templates_dir relative to the config file.
        cfg.templates_dir = str((path.parent / cfg.templates_dir).resolve())
        return cfg
