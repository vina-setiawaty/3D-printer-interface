import math

# ----------------------------- REQUEST PARAMETERS ----------------------------
START_X, START_Y   = 20.0, 100.0     # bottom-left corner of the grid, bed coords (mm)
TARGET_LENGTH      = 120.0           # nominal X extent requested
TARGET_WIDTH       = 80.0            # nominal Y extent requested
CELL_MAX           = 15.0            # starting cell size (mm)
CELL_MIN           = 0.5             # ending cell size (mm)

# ----------------------------- PRINT PARAMETERS -------------------------------
BED_X, BED_Y       = 220.0, 220.0
FIRST_LAYER_Z        = 0.10          # requested: first layer printed at Z=0.1mm
LAYER_HEIGHT        = 0.20
NUM_LAYERS          = 2              # 0.4mm total relief -- "reference/fine grid" tier
GLOBAL_FLOW_PCT      = 120           # requested: +20% extrusion, applied as M221 S120
NOZZLE_DIA          = 0.40
EXTRUSION_WIDTH     = 0.44
FILAMENT_DIA        = 1.75
NOZZLE_TEMP         = 220
BED_TEMP            = 60
PRINT_FEED          = 600            # mm/min, ~10mm/s
Z_FEED              = 300            # mm/min, conservative Z moves
TRAVEL_FEED         = 3000           # mm/min, XY rapid travel
RETRACT_MM          = 0.8            # Sprite direct-drive (Creality spec: 0.8mm PLA)
RETRACT_FEED        = 2400           # mm/min, ~40mm/s (Sprite spec range 35-45mm/s)
Z_HOP               = 0.4            # mm
FIRST_LAYER_FLOW_MULT = 1.2          # restored per request -- stacks with M221 S120 (see note below)

FIL_AREA = math.pi * (FILAMENT_DIA / 2) ** 2

def e_per_mm(layer_h, width, flow_mult=1.0):
    return (width * layer_h * flow_mult) / FIL_AREA

# ----------------------------- GEOMETRIC CELL SIZING --------------------------
def best_progression(s0, smin, target, k_range=range(1, 400)):
    best = None
    for k in k_range:
        r = (smin / s0) ** (1.0 / k)
        total = s0 * (k + 1) if abs(r - 1.0) < 1e-12 else s0 * (1 - r ** (k + 1)) / (1 - r)
        diff = abs(total - target)
        if best is None or diff < best[0]:
            best = (diff, k, r, total)
    return best

_, k_len, r_len, actual_length = best_progression(CELL_MAX, CELL_MIN, TARGET_LENGTH)
_, k_wid, r_wid, actual_width  = best_progression(CELL_MAX, CELL_MIN, TARGET_WIDTH)

def boundaries(s0, r, k):
    sizes = [s0 * (r ** i) for i in range(k + 1)]
    edges = [0.0]
    for s in sizes:
        edges.append(edges[-1] + s)
    return edges  # k+2 edges (k+1 cells... wait k intervals -> k+1 boundaries used below)

x_edges = boundaries(CELL_MAX, r_len, k_len)   # k_len+1 cells -> k_len+2 boundary lines (incl. the x=0 edge)
y_edges = boundaries(CELL_MAX, r_wid, k_wid)

print(f"Length axis: {k_len} cells, {len(x_edges)} vertical lines, achieved length={x_edges[-1]:.3f}mm (target {TARGET_LENGTH})")
print(f"Width  axis: {k_wid} cells, {len(y_edges)} horizontal lines, achieved width={y_edges[-1]:.3f}mm (target {TARGET_WIDTH})")
print(f"Smallest cell: {x_edges[-1]-x_edges[-2]:.3f}mm x {y_edges[-1]-y_edges[-2]:.3f}mm")

actual_length = x_edges[-1]
actual_width = y_edges[-1]

# bed bounds check
assert START_X >= 0 and START_X + actual_length <= BED_X, "X out of bed bounds"
assert START_Y >= 0 and START_Y + actual_width <= BED_Y, "Y out of bed bounds"

# ----------------------------- GCODE GENERATION --------------------------------
lines_out = []
def a(s=""):
    lines_out.append(s)

a("; ------------------------------------------------------------")
a("; Graduated tactile grid -- Ender 3 V2 + Sprite direct drive, PLA")
a(f"; Requested: {TARGET_LENGTH} x {TARGET_WIDTH} mm, cells {CELL_MAX}mm -> {CELL_MIN}mm")
a(f"; Achieved:  {actual_length:.2f} x {actual_width:.2f} mm ({len(x_edges)} vertical / {len(y_edges)} horizontal lines)")
a(f"; NOTE: cells below ~1mm will not read as open gaps -- adjacent line")
a(f"; walls ({EXTRUSION_WIDTH}mm wide) touch/merge once spacing drops under ~2x")
a(f"; extrusion width. This is expected for a resolution-threshold test grid.")
a(f"; NOTE: M221 S{GLOBAL_FLOW_PCT} stacks with the {FIRST_LAYER_FLOW_MULT}x first-layer")
a(f"; flow multiplier baked into layer-1 E values -> ~{GLOBAL_FLOW_PCT/100*FIRST_LAYER_FLOW_MULT:.2f}x nominal flow on layer 1 specifically.")
a(f"; First layer printed at Z={FIRST_LAYER_Z}mm as requested.")
a("; ------------------------------------------------------------")
a("G21 ; units = mm")
a("G90 ; absolute positioning (used for ALL of X/Y/Z in this file)")
a("M83 ; relative extrusion mode -- set ONCE, never toggled, avoids G90/G91 E ambiguity")
a("M220 S100")
a(f"M221 S{GLOBAL_FLOW_PCT} ; +20% global flow, as requested")
a(f"M104 S{NOZZLE_TEMP}")
a(f"M140 S{BED_TEMP}")
a(f"M190 S{BED_TEMP}")
a(f"M109 S{NOZZLE_TEMP}")
a("G28 ; home all axes")
a("G92 E0")
a("G1 Z5 F3000 ; lift before priming")
a("; --- prime line along the front edge ---")
a("G1 X10 Y15 Z0.28 F5000")
a("G1 X10 Y100 Z0.28 F1500 E12")
a("G1 X10.4 Y100 Z0.28 F5000")
a("G1 X10.4 Y15 Z0.28 F1500 E12")
a("G1 F2400 E-0.8 ; retract after prime")
a("G1 Z2.0 F3000")
a("; --- begin grid ---")

currently_retracted = False

for layer_idx in range(NUM_LAYERS):
    z = FIRST_LAYER_Z if layer_idx == 0 else FIRST_LAYER_Z + layer_idx * LAYER_HEIGHT
    flow_mult = FIRST_LAYER_FLOW_MULT if layer_idx == 0 else 1.0
    e_rate = e_per_mm(LAYER_HEIGHT, EXTRUSION_WIDTH, flow_mult)
    a(f"; ----- layer {layer_idx+1}/{NUM_LAYERS}, Z={z:.2f} -----")

    strokes = []
    # vertical lines: constant x, y from 0 to actual_width
    for xe in x_edges:
        strokes.append(((xe, 0.0), (xe, actual_width)))
    # horizontal lines: constant y, x from 0 to actual_length
    for ye in y_edges:
        strokes.append(((0.0, ye), (actual_length, ye)))

    for (sx, sy), (ex, ey) in strokes:
        gx0, gy0 = START_X + sx, START_Y + sy
        gx1, gy1 = START_X + ex, START_Y + ey
        length = math.hypot(gx1 - gx0, gy1 - gy0)
        e_amount = e_rate * length

        a(f"G0 Z{z + Z_HOP:.2f} F{Z_FEED}")
        a(f"G0 X{gx0:.3f} Y{gy0:.3f} F{TRAVEL_FEED}")
        a(f"G0 Z{z:.2f} F{Z_FEED}")
        if currently_retracted:
            a(f"G1 F{RETRACT_FEED} E{RETRACT_MM}")
        a(f"G1 X{gx1:.3f} Y{gy1:.3f} F{PRINT_FEED} E{e_amount:.4f}")
        a(f"G1 F{RETRACT_FEED} E-{RETRACT_MM}")
        currently_retracted = True

a("; --- end of print ---")
a("G1 Z10 F3000")
a(f"G0 X0 Y{BED_Y} F3000")
a("M104 S0")
a("M140 S0")
a("M106 S0")
a("M84 X Y E")

gcode_text = "\n".join(lines_out) + "\n"
with open("/home/claude/grid.gcode", "w") as f:
    f.write(gcode_text)

print(f"\nTotal lines drawn per layer: {len(x_edges) + len(y_edges)}")
print(f"Total gcode lines (with comments): {len(lines_out)}")

# ----------------------------- STRIP COMMENTS -----------------------------
stripped = []
for line in lines_out:
    code = line.split(";")[0].rstrip()
    if code.strip():
        stripped.append(code)

with open("/home/claude/grid.gcode", "w") as f:
    f.write("\n".join(stripped) + "\n")

print(f"Total gcode lines (comments stripped): {len(stripped)}")
print(f"Semicolons remaining: {sum(l.count(';') for l in stripped)}")
