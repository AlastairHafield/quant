# kcd-miner

Screen-reading auto miner for KCD:MP servers (built for KCDonline). It never touches game memory or files.
It takes screenshots, finds things with OpenCV template matching, and sends input through `SendInput`
using pydirectinput.

**Windows only at runtime.** The logic is tested on any OS with fakes (`pytest tests`).

## How it works

```
SEARCH   prompt on screen? -> MINE. Ore node seen? -> APPROACH. Else turn camera a step;
         a full turn with nothing seen -> WAIT
APPROACH turn to centre the node, walk forward in short bursts until the prompt appears
MINE     run mine_action until the prompt goes away (node used up) or max_cycles
WAIT     respawn_wait_s, then SEARCH
```

With no `node` template, the bot doesn't move. It stands at a node and mines whenever the prompt shows.
That is the most reliable mode, so start with it.

Every loop it checks:
- the pause/quit hotkeys (F8/F9 by default);
- that the game window has focus. If not, it lets go of all keys and waits;
- `abort_on` templates, e.g. a full inventory;
- max runtime and random breaks.

Every delay has gaussian jitter.

## Setup

```
pip install -r requirements.txt
copy config.example.json config.json
```

1. Run the game in **borderless windowed** at your normal resolution.
2. Run `python -m kcd_miner capture --delay 5` while the mining prompt is on screen. Crop just the prompt
   (icon plus text) out of `captures/screen_*.png` into `templates/prompt.png`. Do the same for:
   - `node.png`: a distinctive part of the ore node, cropped at middle distance;
   - `inventory_full.png`: optional, whatever message the server shows when you can't carry more.
3. Run `python -m kcd_miner debug` and watch the scores. Set each `threshold` between the score you get
   when the thing is there and when it isn't. Shrink `region` so the bot searches less of the screen,
   which avoids false matches.
4. Set `mine_action` to match how the server's mining works:
   - `hold_key`: hold `key` for `hold_s` seconds;
   - `tap_key`: tap a key once per cycle;
   - `click`: one mouse click per cycle;
   - `hold_mouse`: hold `button` for `hold_s` seconds.

   `after_s` is the pause after each cycle.
5. Tune `scan.step_px` and `approach.turn_gain` to your mouse sensitivity. `turn_gain` is the number of
   mouse units per pixel of screen offset. If the camera overshoots, lower it.
6. Run `python -m kcd_miner run`. Switch to the game within `--delay` seconds.

If the game ignores input, run the terminal as administrator. If the game runs elevated, Windows blocks
input from unelevated processes.

## Known limits

- **Template matching breaks when lighting changes**, e.g. day/night or weather. Capture templates
  at the times you'll be playing, or add more than one `node` template.
- Walking to a node assumes open ground. There's no obstacle avoidance. If it gets stuck, the approach
  times out and it goes back to scanning.
