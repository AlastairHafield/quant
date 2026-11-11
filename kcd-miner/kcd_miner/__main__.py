"""
python -m kcd_miner run     --config config.json
python -m kcd_miner capture --config config.json [--delay 3]
python -m kcd_miner debug   --config config.json
"""
import argparse
import time
from pathlib import Path

from .config import Config


def cmd_run(cfg, args):
    from .bot import MinerBot
    from .hotkeys import Controls
    from .humanize import Humanizer
    from .platform import Input, Screen, window_focused
    from .vision import Matcher

    matcher = Matcher(cfg.templates, cfg.templates_dir)
    if not matcher.has("prompt"):
        raise SystemExit("config needs at least a 'prompt' template")
    ctl = Controls()
    ctl.listen(cfg.hotkeys["pause"], cfg.hotkeys["quit"])
    print(f"Starting in {args.delay}s - switch to the game. "
          f"{cfg.hotkeys['pause'].upper()}=pause/resume, {cfg.hotkeys['quit'].upper()}=quit")
    time.sleep(args.delay)
    bot = MinerBot(cfg, matcher, Screen(cfg.monitor), Input(), ctl, Humanizer(cfg.jitter),
                   focused=lambda: window_focused(cfg.window_title))
    bot.run()


def cmd_capture(cfg, args):
    import cv2
    from .platform import Screen
    out = Path(cfg.templates_dir).parent / "captures"
    out.mkdir(exist_ok=True)
    print(f"Capturing in {args.delay}s...")
    time.sleep(args.delay)
    p = out / f"screen_{int(time.time())}.png"
    cv2.imwrite(str(p), Screen(cfg.monitor).grab())
    print(f"saved {p} - crop the prompt/node/etc. out of it into {cfg.templates_dir}")


def cmd_debug(cfg, args):
    from .platform import Screen
    from .vision import Matcher
    matcher = Matcher(cfg.templates, cfg.templates_dir)
    screen = Screen(cfg.monitor)
    print("Live match scores (Ctrl+C to stop). Tune thresholds so 'found' is reliable.")
    try:
        while True:
            frame = screen.grab()
            parts = []
            for name in cfg.templates:
                r = matcher.find(name, frame)
                parts.append(f"{name}={r.score:.2f}{'*' if r.found else ''}@({r.x},{r.y})")
            print("  ".join(parts), flush=True)
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass


def main():
    ap = argparse.ArgumentParser(prog="kcd_miner")
    ap.add_argument("command", choices=["run", "capture", "debug"])
    ap.add_argument("--config", default="config.json")
    ap.add_argument("--delay", type=float, default=5.0)
    args = ap.parse_args()
    cfg = Config.load(args.config)
    {"run": cmd_run, "capture": cmd_capture, "debug": cmd_debug}[args.command](cfg, args)


if __name__ == "__main__":
    main()
