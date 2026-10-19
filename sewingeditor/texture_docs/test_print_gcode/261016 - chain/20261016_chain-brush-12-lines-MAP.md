# Chain-brush exploration (12 lines) -- TPU, nozzle 220C, bed 50C

All lines run +X from X=40 to X=100. Y given per line. Heights are nozzle Z above the bed. e is commanded filament; the header sets M221 S180, so actual filament = e x 1.8. Reference bead (0.4 x 0.2): e/d = 0.0333. Flow cap (placeholder) = 4 mm3/s.

## L1 Baseline bead  (Y=25)
normal print: low nozzle, normal flow

| h (mm) | e (mm) | d (mm) | e/d | F (mm/min) | mode | ~mm3/s | dwell |
|---|---|---|---|---|---|---|---|
| 0.20 | 1.996 | 60.0 | 0.033 | 400 | step | 0.96 | - |

## L2 Low + overextruded  (Y=39)
3x flow at bed height -> wide flat squished bead

| h (mm) | e (mm) | d (mm) | e/d | F (mm/min) | mode | ~mm3/s | dwell |
|---|---|---|---|---|---|---|---|
| 0.20 | 6.000 | 60.0 | 0.100 | 300 | step | 2.16 | - |

## L3 Raised + normal flow  (Y=53)
1mm gap, normal flow -> thin stretched/draped string

| h (mm) | e (mm) | d (mm) | e/d | F (mm/min) | mode | ~mm3/s | dwell |
|---|---|---|---|---|---|---|---|
| 1.00 | 1.996 | 60.0 | 0.033 | 400 | step | 0.96 | - |

## L4 Raised + high flow  (Y=67)
1mm gap, 4.5x flow -> wavy/buckled bead

| h (mm) | e (mm) | d (mm) | e/d | F (mm/min) | mode | ~mm3/s | dwell |
|---|---|---|---|---|---|---|---|
| 1.00 | 9.000 | 60.0 | 0.150 | 250 | step | 2.71 | - |

## L5 High + very high flow  (Y=81)
3mm gap, 7.5x flow, slow -> coiling loops

| h (mm) | e (mm) | d (mm) | e/d | F (mm/min) | mode | ~mm3/s | dwell |
|---|---|---|---|---|---|---|---|
| 3.00 | 15.000 | 60.0 | 0.250 | 200 | step | 3.61 | - |

## L6 High + very low flow  (Y=95)
3mm gap, 0.3x flow -> thin fibre, may break

| h (mm) | e (mm) | d (mm) | e/d | F (mm/min) | mode | ~mm3/s | dwell |
|---|---|---|---|---|---|---|---|
| 3.00 | 0.600 | 60.0 | 0.010 | 600 | step | 0.43 | - |

## L7 Chain: height alternates (step)  (Y=109)
0.2mm / 2.0mm every 5mm, same flow -> flat bead / loop clusters -- pattern repeats to the end of the line

| h (mm) | e (mm) | d (mm) | e/d | F (mm/min) | mode | ~mm3/s | dwell |
|---|---|---|---|---|---|---|---|
| 0.20 | 0.300 | 5.0 | 0.060 | 300 | step | 1.30 | - |
| 2.00 | 0.300 | 5.0 | 0.060 | 300 | step | 1.30 | - |

## L8 Chain: height alternates (ramp)  (Y=123)
same as L7 but Z ramps within each segment -> compare with L7 -- pattern repeats to the end of the line

| h (mm) | e (mm) | d (mm) | e/d | F (mm/min) | mode | ~mm3/s | dwell |
|---|---|---|---|---|---|---|---|
| 0.20 | 0.300 | 5.0 | 0.060 | 300 | ramp | 1.30 | - |
| 2.00 | 0.300 | 5.0 | 0.060 | 300 | ramp | 1.30 | - |

## L9 Chain: flow alternates  (Y=137)
0.6mm height, e/d 0.02 / 0.15 every 5mm -> thin string / beads -- pattern repeats to the end of the line

| h (mm) | e (mm) | d (mm) | e/d | F (mm/min) | mode | ~mm3/s | dwell |
|---|---|---|---|---|---|---|---|
| 0.60 | 0.100 | 5.0 | 0.020 | 300 | step | 0.43 | - |
| 0.60 | 0.750 | 5.0 | 0.150 | 250 | step | 2.71 | - |

## L10 Chain: beads on a string (d=0)  (Y=151)
6mm thin travel (ramping down from the previous bead), then 0.6mm extruded in place while rising to 1.2mm -- pattern repeats to the end of the line

| h (mm) | e (mm) | d (mm) | e/d | F (mm/min) | mode | ~mm3/s | dwell |
|---|---|---|---|---|---|---|---|
| 0.30 | 0.120 | 6.0 | 0.020 | 400 | ramp | 0.58 | - |
| 1.20 | 0.600 | 0.0 | - | 60 | in place | 2.89 | 500 |

## L11 Height sweep  (Y=165)
e/d fixed 0.08, height 0.48 -> 3.0 in 10 ramps of 6mm

| h (mm) | e (mm) | d (mm) | e/d | F (mm/min) | mode | ~mm3/s | dwell |
|---|---|---|---|---|---|---|---|
| 0.48 | 0.480 | 6.0 | 0.080 | 300 | ramp | 1.73 | - |
| 0.76 | 0.480 | 6.0 | 0.080 | 300 | ramp | 1.73 | - |
| 1.04 | 0.480 | 6.0 | 0.080 | 300 | ramp | 1.73 | - |
| 1.32 | 0.480 | 6.0 | 0.080 | 300 | ramp | 1.73 | - |
| 1.60 | 0.480 | 6.0 | 0.080 | 300 | ramp | 1.73 | - |
| 1.88 | 0.480 | 6.0 | 0.080 | 300 | ramp | 1.73 | - |
| 2.16 | 0.480 | 6.0 | 0.080 | 300 | ramp | 1.73 | - |
| 2.44 | 0.480 | 6.0 | 0.080 | 300 | ramp | 1.73 | - |
| 2.72 | 0.480 | 6.0 | 0.080 | 300 | ramp | 1.73 | - |
| 3.00 | 0.480 | 6.0 | 0.080 | 300 | ramp | 1.73 | - |

## L12 Flow sweep  (Y=179)
height fixed 1.5, e/d 0.01 -> 0.25 in 10 steps of 6mm

| h (mm) | e (mm) | d (mm) | e/d | F (mm/min) | mode | ~mm3/s | dwell |
|---|---|---|---|---|---|---|---|
| 1.50 | 0.060 | 6.0 | 0.010 | 200 | step | 0.14 | - |
| 1.50 | 0.220 | 6.0 | 0.037 | 200 | step | 0.53 | - |
| 1.50 | 0.380 | 6.0 | 0.063 | 200 | step | 0.91 | - |
| 1.50 | 0.540 | 6.0 | 0.090 | 200 | step | 1.30 | - |
| 1.50 | 0.700 | 6.0 | 0.117 | 200 | step | 1.68 | - |
| 1.50 | 0.860 | 6.0 | 0.143 | 200 | step | 2.07 | - |
| 1.50 | 1.020 | 6.0 | 0.170 | 200 | step | 2.45 | - |
| 1.50 | 1.180 | 6.0 | 0.197 | 200 | step | 2.84 | - |
| 1.50 | 1.340 | 6.0 | 0.223 | 200 | step | 3.22 | - |
| 1.50 | 1.500 | 6.0 | 0.250 | 200 | step | 3.61 | - |

Totals: 1568 G-code lines, 68.4 mm commanded filament.
