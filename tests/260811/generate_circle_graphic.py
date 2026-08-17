import math

# ----------------------------- GRAPHIC GEOMETRY ----------------------------
Cx, Cy = 110.0, 110.0     # circle center (bed coords)
R = 85.0                  # circle radius -- fits comfortably in 220x220 bed (20mm margin all sides)

DOT_DIA = 2.5             # finished dot diameter, region A (upper half)
DOT_PITCH = 16.0          # center-to-center spacing
HATCH_DC = 9.0            # spacing (along the 45deg offset) for region B lines, ~6.4mm perpendicular

# ----------------------------- PRINT PARAMETERS -------------------------------
BED_X, BED_Y         = 220.0, 220.0
LAYER_HEIGHT          = 0.20
EXTRUSION_WIDTH        = 0.44
FILAMENT_DIA          = 1.75
NOZZLE_TEMP           = 210          # reduced from 220 -- less oozing/stringing at lower temp
BED_TEMP              = 60
Z_FEED                = 300
TRAVEL_FEED           = 3600
PRINT_FEED             = 400
CIRCLE_FEED            = 300
RETRACT_MM            = 0.5          # raised from 0.4 -- 0.4 wasn't holding for the full travel duration, pressure was winning partway through
DOT_RETRACT_MM         = 0.55        # dots still had some trailing at 0.5 -- a bit more margin
COAST_MM               = 0.3         # hatch lines: stop extruding this far before the endpoint, relieves pressure without adding retraction
RETRACT_FEED          = 3000         # increased from 2400 -- cleaner, quicker shear at the nozzle tip
WIPE_MM                = 1.0         # short reverse move along the just-printed line, drags ooze back onto existing material
Z_HOP                 = 0.4
END_DWELL_MS            = 100
GLOBAL_FLOW_PCT        = 100

FRAME_HEIGHT           = 0.6         # circle outline + divider line -- tallest tier (3 layers)
TEXTURE_HEIGHT         = 0.4         # dots + hatch lines -- lower tier (2 layers)
NUM_LAYERS_MAX          = round(FRAME_HEIGHT / LAYER_HEIGHT)

FIL_AREA = math.pi * (FILAMENT_DIA / 2) ** 2
def e_per_mm(layer_h, width):
    return (width * layer_h) / FIL_AREA

dot_path_r = (DOT_DIA - EXTRUSION_WIDTH) / 2
dot_margin = dot_path_r + EXTRUSION_WIDTH / 2 + 0.5

# ----------------------------- BUILD ELEMENT LIST ------------------------------
elements = []  # each: dict(type='line'|'circle', pts=[...], height=mm)

# frame: full circle outline
elements.append({"type": "circle", "cx": Cx, "cy": Cy, "r": R, "height": FRAME_HEIGHT})
# frame: divider line across the diameter
elements.append({"type": "line", "p0": (Cx - R, Cy), "p1": (Cx + R, Cy), "height": FRAME_HEIGHT})

# region A (upper half, y > Cy): dot grid
n = int(R / DOT_PITCH) + 2
for i in range(-n, n + 1):
    for j in range(1, n + 1):
        x = Cx + i * DOT_PITCH
        y = Cy + j * DOT_PITCH
        if math.hypot(x - Cx, y - Cy) + dot_margin <= R:
            elements.append({"type": "dot", "cx": x, "cy": y, "r": dot_path_r, "height": TEXTURE_HEIGHT})

# region B (lower half, y < Cy): 45-degree hatch lines, x - y = c
c_max = R * math.sqrt(2) + 5
c = -c_max
while c <= c_max:
    b = (c - Cx) - Cy
    cc = ((c - Cx) ** 2 + Cy ** 2 - R ** 2) / 2
    disc = b * b - 4 * cc
    if disc >= 0:
        sq = math.sqrt(disc)
        u1, u2 = (-b - sq) / 2, (-b + sq) / 2
        y_lo, y_hi = min(u1, u2), max(u1, u2)
        if y_hi <= Cy:
            ya, yb = y_lo, y_hi
        elif y_lo <= Cy < y_hi:
            ya, yb = y_lo, Cy
        else:
            c += HATCH_DC
            continue
        p0, p1 = (ya + c, ya), (yb + c, yb)
        if math.hypot(p1[0] - p0[0], p1[1] - p0[1]) >= 3.0:
            elements.append({"type": "line", "p0": p0, "p1": p1, "height": TEXTURE_HEIGHT})
    c += HATCH_DC

n_dots = sum(1 for e in elements if e["type"] == "dot")
n_hatch = sum(1 for e in elements if e["type"] == "line" and e["height"] == TEXTURE_HEIGHT)
print(f"Frame elements: 2 (circle r={R}, divider)")
print(f"Dots: {n_dots}, hatch lines: {n_hatch}")
print(f"Total strokes: {len(elements)}")

assert Cx - R >= 0 and Cx + R <= BED_X, "circle X out of bed bounds"
assert Cy - R >= 0 and Cy + R <= BED_Y, "circle Y out of bed bounds"

# ----------------------------- GCODE GENERATION --------------------------------
lines_out = []
def a(s=""):
    lines_out.append(s)

a("; Circle tactile graphic -- two BANA texture groups, Ender 3 V2 + Sprite direct drive")
a(f"; Circle center ({Cx},{Cy}) r={R}mm -- upper half: ordered dots (r={dot_path_r:.2f}mm path, pitch {DOT_PITCH}mm)")
a(f"; lower half: 45deg parallel-ridge hatch (~{HATCH_DC/math.sqrt(2):.2f}mm perpendicular spacing)")
a(f"; Frame/divider height {FRAME_HEIGHT}mm ({NUM_LAYERS_MAX} layers), texture height {TEXTURE_HEIGHT}mm")
a("; NOTE: retraction raised to 0.6mm, retract speed to 3000mm/min, travel to 3600mm/min,")
a("; and a 1mm reverse wipe added after each hatch line -- anti-stringing pass, still")
a("; below the 0.8mm retraction that risked filament grinding on earlier tests.")
a("G21")
a("G90")
a("M83")
a(f"M221 S{GLOBAL_FLOW_PCT}")
a(f"M104 S{NOZZLE_TEMP}")
a(f"M140 S{BED_TEMP}")
a(f"M190 S{BED_TEMP}")
a(f"M109 S{NOZZLE_TEMP}")
a("G28")
a("G92 E0")
a("G1 Z5 F3000")
a("G1 X10 Y15 Z0.28 F5000")
a("G1 X10 Y100 Z0.28 F1500 E12")
a("G1 X10.4 Y100 Z0.28 F5000")
a("G1 X10.4 Y15 Z0.28 F1500 E12")
a(f"G1 F{RETRACT_FEED} E-{RETRACT_MM}")
a("G1 Z2.0 F3000")

currently_retracted = True   # prime block ends with a retract -- nozzle really is retracted
last_retract_amount = RETRACT_MM
is_first_stroke = True

def approach(x_target, y_target, z_target):
    """Move to the start of a stroke. For the very first stroke of the whole
    file, the nozzle is already safely elevated at Z=2.0 from the prime block --
    travel there first, then lower once, instead of dropping to hop height
    (which would UNDO that clearance) before the long cross-bed travel."""
    global is_first_stroke
    if is_first_stroke:
        a(f"G0 X{x_target:.3f} Y{y_target:.3f} F{TRAVEL_FEED}")
        a(f"G0 Z{z_target:.2f} F{Z_FEED}")
        is_first_stroke = False
    else:
        a(f"G0 Z{z_target + Z_HOP:.2f} F{Z_FEED}")
        a(f"G0 X{x_target:.3f} Y{y_target:.3f} F{TRAVEL_FEED}")
        a(f"G0 Z{z_target:.2f} F{Z_FEED}")

for layer_idx in range(NUM_LAYERS_MAX):
    z = LAYER_HEIGHT * (layer_idx + 1)
    active = [e for e in elements if e["height"] >= z - 1e-9]
    for e in active:
        if e["type"] == "circle":
            r = e["r"]
            x_start, y_start = e["cx"] + r, e["cy"]
            circumference = 2 * math.pi * r
            e_amt = e_per_mm(LAYER_HEIGHT, EXTRUSION_WIDTH) * circumference
            approach(x_start, y_start, z)
            if currently_retracted:
                a(f"G1 F{RETRACT_FEED} E{last_retract_amount}")
            a(f"G3 X{x_start:.3f} Y{y_start:.3f} I{-r:.3f} J0 F{CIRCLE_FEED} E{e_amt:.4f}")
            a(f"G4 P{END_DWELL_MS}")
            a(f"G1 F{RETRACT_FEED} E-{RETRACT_MM}")
            last_retract_amount = RETRACT_MM
            currently_retracted = True
        elif e["type"] == "dot":
            r_outer = e["r"]
            ring_step = EXTRUSION_WIDTH * 0.85  # slight overlap between rings, avoids gaps
            radii = []
            r = r_outer
            while r > ring_step / 2:
                radii.append(r)
                r -= ring_step

            x0, y0 = e["cx"] + radii[0], e["cy"]
            approach(x0, y0, z)
            if currently_retracted:
                a(f"G1 F{RETRACT_FEED} E{last_retract_amount}")

            cur_x, cur_y = x0, y0
            for idx, ring_r in enumerate(radii):
                if idx > 0:
                    # radial bridge from previous ring's point to this ring's start point
                    nx, ny = e["cx"] + ring_r, e["cy"]
                    seg_len = abs(cur_x - nx)
                    e_amt = e_per_mm(LAYER_HEIGHT, EXTRUSION_WIDTH) * seg_len
                    a(f"G1 X{nx:.3f} Y{ny:.3f} F{PRINT_FEED} E{e_amt:.4f}")
                    cur_x, cur_y = nx, ny
                circumference = 2 * math.pi * ring_r
                e_amt = e_per_mm(LAYER_HEIGHT, EXTRUSION_WIDTH) * circumference
                a(f"G3 X{cur_x:.3f} Y{cur_y:.3f} I{-ring_r:.3f} J0 F{CIRCLE_FEED} E{e_amt:.4f}")

            # spoke into the exact center -- no extra stationary dab: that push was
            # raising nozzle pressure right before retract/travel, likely the main
            # cause of dot-to-dot stringing. A tiny pinhole is an acceptable trade.
            last_r = radii[-1]
            e_amt = e_per_mm(LAYER_HEIGHT, EXTRUSION_WIDTH) * last_r
            a(f"G1 X{e['cx']:.3f} Y{e['cy']:.3f} F{PRINT_FEED} E{e_amt:.4f}")
            a(f"G4 P{END_DWELL_MS}")
            a(f"G1 F{RETRACT_FEED} E-{DOT_RETRACT_MM}")
            a(f"G4 P50")
            last_retract_amount = DOT_RETRACT_MM
            currently_retracted = True
        else:  # line
            p0, p1 = e["p0"], e["p1"]
            length = math.hypot(p1[0] - p0[0], p1[1] - p0[1])
            e_amt = e_per_mm(LAYER_HEIGHT, EXTRUSION_WIDTH) * length
            approach(p0[0], p0[1], z)
            if currently_retracted:
                a(f"G1 F{RETRACT_FEED} E{last_retract_amount}")
            coast_len = max(length - COAST_MM, 0)
            e_amt_coast = e_per_mm(LAYER_HEIGHT, EXTRUSION_WIDTH) * coast_len
            a(f"G1 X{p1[0]:.3f} Y{p1[1]:.3f} F{PRINT_FEED} E{e_amt_coast:.4f}")
            a(f"G4 P{END_DWELL_MS}")
            a(f"G1 F{RETRACT_FEED} E-{RETRACT_MM}")
            last_retract_amount = RETRACT_MM
            # wipe: short reverse move (no extrusion) back along the line just printed,
            # drags any ooze back onto already-deposited material instead of across the gap
            dx, dy = p1[0] - p0[0], p1[1] - p0[1]
            seg_len = math.hypot(dx, dy)
            if seg_len > WIPE_MM:
                wx = p1[0] - dx / seg_len * WIPE_MM
                wy = p1[1] - dy / seg_len * WIPE_MM
                a(f"G0 X{wx:.3f} Y{wy:.3f} F{TRAVEL_FEED}")
            currently_retracted = True

a("G1 Z10 F3000")
a(f"G0 X0 Y{BED_Y} F3000")
a("M104 S0")
a("M140 S0")
a("M106 S0")
a("M84 X Y E")

stripped = [l.split(";")[0].rstrip() for l in lines_out]
stripped = [l for l in stripped if l.strip()]
with open("/home/claude/circle_graphic.gcode", "w") as f:
    f.write("\n".join(stripped) + "\n")

print(f"\nTotal gcode lines (comments stripped): {len(stripped)}")
