import math

# ============================================================================
# CONSOLIDATED CIRCLE-PRINTING KNOWLEDGE (this session, Ender 3 V2 + Sprite)
#
# GEOMETRY
#   - A traced circular path swells outward by ~half the extrusion width on
#     each side once printed. To hit a target FINISHED diameter:
#         path_diameter = target_diameter - EXTRUSION_WIDTH
#   - A single perimeter loop only reads as "solid" when the path diameter is
#     small enough that the line width itself nearly fills it (true for ~1mm
#     dots). Anything bigger needs CONCENTRIC RING INFILL: trace the outer
#     loop, step inward by ~0.85x extrusion width, trace the next loop, and
#     so on toward the center.
#
# PRINT ORDER
#   - Start on the outer ring, spiral inward ring by ring, connected by short
#     straight radial bridges (not retract-travel-retract between rings).
#   - Finish with a short spoke into the exact center -- NOT a stationary
#     "insurance dab". A stationary extra push right before retract raises
#     nozzle pressure at the worst possible moment and was a direct cause of
#     bad trailing when tried. A small pinhole from an unclosed center is a
#     better trade than that.
#   - Ending the path at the center means any residual ooze during retract/
#     lift-off lands inside material that's already down, not in the gap
#     toward the next circle.
#   - Retract ONCE per circle, after all rings -- not once per ring. More
#     internal geometry does not have to mean more retraction cycles (which
#     is what actually caused the grinding/fading failure earlier).
#
# ANTI-TRAILING TECHNIQUES (in order of how much they mattered)
#   1. Track the ACTUAL last-retracted amount and de-retract by that exact
#      value -- if any stroke type retracts a different distance than
#      another, a fixed de-retract assumption silently drifts under-primed.
#   2. Retraction distance: circles/dots need more than straight lines do
#      (more internal pressure from a longer continuous multi-ring path).
#      0.4mm was insufficient -- pressure was winning partway through long
#      travels. 0.55mm held for the circle sizes tested here.
#   3. Faster retract speed (3000mm/min) shears cleanly rather than a slow
#      drool.
#   4. A settling dwell AFTER the print move but BEFORE retract (lets the
#      deposit bond before pulling back), AND a second short dwell AFTER
#      retract but BEFORE travel (lets internal pressure fully relax before
#      the nozzle starts moving).
#   5. Preserve Z clearance through long travels. A naive "hop to hop-height"
#      step can actually LOWER the nozzle if it's already elevated (e.g.
#      right after the prime line's safety lift) -- always take the max of
#      current safe height and the hop target, never assume hop = up.
#   6. Faster travel feed (3600mm/min) shortens the exposure window.
#   7. Light coasting (stop commanding new extrusion a fraction of a mm
#      before the geometric endpoint) relieves pressure for the last bit of
#      any print move without needing more retraction.
# ============================================================================

# ----------------------------- REQUEST PARAMETERS ----------------------------
START_X, START_Y     = 20.0, 40.0     # first circle's center
DIAMETERS             = list(range(1, 11))   # 1mm..10mm finished diameters
PITCH                 = 15.0          # mm between circle centers

# ----------------------------- PRINT PARAMETERS -------------------------------
BED_X, BED_Y         = 220.0, 220.0
LAYER_HEIGHT          = 0.20
EXTRUSION_WIDTH        = 0.44
FILAMENT_DIA          = 1.75
NOZZLE_TEMP           = 210
BED_TEMP              = 60
Z_FEED                = 300
TRAVEL_FEED           = 3600
PRINT_FEED             = 400
CIRCLE_FEED            = 300
RETRACT_MM            = 0.55
RETRACT_FEED          = 3000
Z_HOP                 = 0.4
END_DWELL_MS            = 100         # settle before retract
POST_RETRACT_DWELL_MS    = 50         # settle after retract, before travel
COAST_MM               = 0.2          # applied to the final center spoke
RING_STEP_FACTOR        = 0.85        # concentric ring spacing, x extrusion width
GLOBAL_FLOW_PCT        = 100

FIL_AREA = math.pi * (FILAMENT_DIA / 2) ** 2
def e_per_mm(layer_h, width):
    return (width * layer_h) / FIL_AREA

# ----------------------------- BUILD CIRCLE LIST -------------------------------
circles = []
for i, dia in enumerate(DIAMETERS):
    cx = START_X + i * PITCH
    cy = START_Y
    path_r = (dia - EXTRUSION_WIDTH) / 2
    if path_r <= 0:
        raise ValueError(f"{dia}mm target is smaller than the extrusion width -- can't be traced")
    circles.append({"cx": cx, "cy": cy, "dia": dia, "r": path_r})

for c in circles:
    print(f"target {c['dia']}mm -> path radius {c['r']:.3f}mm, center ({c['cx']:.1f}, {c['cy']:.1f})")

last_x = circles[-1]["cx"] + circles[-1]["r"]
assert START_X - circles[0]["r"] >= 0, "first circle out of bed bounds (X)"
assert last_x <= BED_X, "last circle out of bed bounds (X)"
assert START_Y - max(c["r"] for c in circles) >= 0 and START_Y + max(c["r"] for c in circles) <= BED_Y, "circle row out of bed bounds (Y)"

# ----------------------------- GCODE GENERATION --------------------------------
lines_out = []
def a(s=""):
    lines_out.append(s)

a("; Circle diameter calibration row -- Ender 3 V2 + Sprite direct drive")
a(f"; {len(circles)} circles, {DIAMETERS[0]}mm-{DIAMETERS[-1]}mm, {PITCH}mm pitch, start ({START_X},{START_Y})")
a("; Consolidated geometry + anti-trailing technique from this session (see script header)")
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
a("G1 X10 Y30 Z0.28 F1500 E12")
a("G1 X10.4 Y30 Z0.28 F5000")
a("G1 X10.4 Y15 Z0.28 F1500 E12")
a(f"G1 F{RETRACT_FEED} E-{RETRACT_MM}")
a("G1 Z2.0 F3000")

currently_retracted = True
last_retract_amount = RETRACT_MM
is_first_stroke = True

def approach(x_target, y_target, z_target):
    global is_first_stroke
    if is_first_stroke:
        a(f"G0 X{x_target:.3f} Y{y_target:.3f} F{TRAVEL_FEED}")
        a(f"G0 Z{z_target:.2f} F{Z_FEED}")
        is_first_stroke = False
    else:
        a(f"G0 Z{z_target + Z_HOP:.2f} F{Z_FEED}")
        a(f"G0 X{x_target:.3f} Y{y_target:.3f} F{TRAVEL_FEED}")
        a(f"G0 Z{z_target:.2f} F{Z_FEED}")

z = LAYER_HEIGHT
for c in circles:
    r_outer = c["r"]
    ring_step = EXTRUSION_WIDTH * RING_STEP_FACTOR
    radii = []
    r = r_outer
    while r > ring_step / 2:
        radii.append(r)
        r -= ring_step
    if not radii:
        radii = [r_outer]

    x0, y0 = c["cx"] + radii[0], c["cy"]
    approach(x0, y0, z)
    if currently_retracted:
        a(f"G1 F{RETRACT_FEED} E{last_retract_amount}")

    cur_x, cur_y = x0, y0
    for idx, ring_r in enumerate(radii):
        if idx > 0:
            nx, ny = c["cx"] + ring_r, c["cy"]
            seg_len = abs(cur_x - nx)
            e_amt = e_per_mm(LAYER_HEIGHT, EXTRUSION_WIDTH) * seg_len
            a(f"G1 X{nx:.3f} Y{ny:.3f} F{PRINT_FEED} E{e_amt:.4f}")
            cur_x, cur_y = nx, ny
        circumference = 2 * math.pi * ring_r
        e_amt = e_per_mm(LAYER_HEIGHT, EXTRUSION_WIDTH) * circumference
        a(f"G3 X{cur_x:.3f} Y{cur_y:.3f} I{-ring_r:.3f} J0 F{CIRCLE_FEED} E{e_amt:.4f}")

    # spoke into the exact center, with light coasting -- no stationary dab
    last_r = radii[-1]
    coast_len = max(last_r - COAST_MM, 0)
    e_amt = e_per_mm(LAYER_HEIGHT, EXTRUSION_WIDTH) * coast_len
    a(f"G1 X{c['cx']:.3f} Y{c['cy']:.3f} F{PRINT_FEED} E{e_amt:.4f}")
    a(f"G4 P{END_DWELL_MS}")
    a(f"G1 F{RETRACT_FEED} E-{RETRACT_MM}")
    a(f"G4 P{POST_RETRACT_DWELL_MS}")
    last_retract_amount = RETRACT_MM
    currently_retracted = True

a("G1 Z10 F3000")
a(f"G0 X0 Y{BED_Y} F3000")
a("M104 S0")
a("M140 S0")
a("M106 S0")
a("M84 X Y E")

stripped = [l.split(";")[0].rstrip() for l in lines_out]
stripped = [l for l in stripped if l.strip()]
with open("/home/claude/circle_calibration.gcode", "w") as f:
    f.write("\n".join(stripped) + "\n")

print(f"\nTotal gcode lines (comments stripped): {len(stripped)}")
