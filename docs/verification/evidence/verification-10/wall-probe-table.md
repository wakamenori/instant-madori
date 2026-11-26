# 検証10の試作の表

`57f6f59b1` で `mise exec -- cargo test --release -p madori-modeling wall_probe_table -- --ignored --nocapture` を実行した出力のうち、表と詳細の行である。ms は一回だけの測定で、A1 は `Model::build` 全体、A2 と B は CAD のコマンドだけの時間である。作れない行は、理由をそのまま載せた。

| case | method | build | walls/bodies | overlap (tol) mm³ | excess/deficit (tol) mm³ | Σvol − vol(R) mm³ | branchless planforms vs A1 | B vs A2 | roles | unexplained | joint faces | colours | opening ∩ neighbour mm³ | commands | ms | B fragments |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| P30 | A2 | first | 7/7 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | — | — | 28/28 | 0 | 20 | 3 | 0.00 | 31 | 17.21 | 0 |
| P30 | A1 | first | 7/7 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | pass | — | 28/28 | 0 | 14 | 3 | 0.00 | — | 19.93 | 0 |
| P30 | B | first | 7/7 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | pass | 28/28 | 0 | 20 | 3 | 0.00 | 48 | 328.46 | 29 |
| P30 | A2 | rebuild | 7/7 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | — | — | 28/28 | 0 | 20 | 3 | 0.00 | 31 | 7.52 | 0 |
| P30 | A1 | rebuild | 7/7 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | pass | — | 28/28 | 0 | 14 | 3 | 0.00 | — | 9.36 | 0 |
| P30 | B | rebuild | 7/7 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | pass | 28/28 | 0 | 20 | 3 | 0.00 | 48 | 325.05 | 29 |
| P45 | A2 | first | 7/7 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | — | — | 28/28 | 0 | 20 | 3 | 0.00 | 31 | 16.98 | 0 |
| P45 | A1 | first | 7/7 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | pass | — | 28/28 | 0 | 14 | 3 | 0.00 | — | 18.87 | 0 |
| P45 | B | first | 7/7 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | — | pass | 28/28 | 0 | 20 | 3 | 0.00 | 50 | 349.33 | 31 |
| P45 | A2 | rebuild | 7/7 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | — | — | 28/28 | 0 | 20 | 3 | 0.00 | 31 | 7.45 | 0 |
| P45 | A1 | rebuild | 7/7 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | pass | — | 28/28 | 0 | 14 | 3 | 0.00 | — | 8.43 | 0 |
| P45 | B | rebuild | 7/7 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | — | pass | 28/28 | 0 | 20 | 3 | 0.00 | 50 | 336.15 | 31 |
| P60 | A2 | first | 7/7 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | — | 28/28 | 0 | 20 | 3 | 0.00 | 31 | 16.90 | 0 |
| P60 | A1 | first | 7/7 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | pass | — | 28/28 | 0 | 14 | 3 | 0.00 | — | 18.29 | 0 |
| P60 | B | first | 7/7 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | pass | 28/28 | 0 | 20 | 3 | 0.00 | 40 | 246.51 | 23 |
| P60 | A2 | rebuild | 7/7 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | — | 28/28 | 0 | 20 | 3 | 0.00 | 31 | 7.46 | 0 |
| P60 | A1 | rebuild | 7/7 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | pass | — | 28/28 | 0 | 14 | 3 | 0.00 | — | 8.83 | 0 |
| P60 | B | rebuild | 7/7 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | pass | 28/28 | 0 | 20 | 3 | 0.00 | 40 | 247.25 | 23 |
| W | A2 | first | 7/7 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | — | 28/28 | 0 | 20 | 3 | 0.00 | 35 | 20.94 | 0 |
| W | A1 | first | 7/7 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | pass | — | 28/28 | 0 | 14 | 3 | 0.00 | — | 23.15 | 0 |
| W | B | first | 7/7 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | pass | 28/28 | 0 | 20 | 3 | 0.00 | 44 | 237.39 | 23 |
| W | A2 | rebuild | 7/7 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | — | 28/28 | 0 | 20 | 3 | 0.00 | 35 | 13.02 | 0 |
| W | A1 | rebuild | 7/7 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | pass | — | 28/28 | 0 | 14 | 3 | 0.00 | — | 15.72 | 0 |
| W | B | rebuild | 7/7 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | pass | 28/28 | 0 | 20 | 3 | 0.00 | 44 | 244.51 | 23 |
| A20 | A2 | first | 7/7 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | — | 28/28 | 0 | 20 | 3 | 0.00 | 31 | 16.90 | 0 |
| A20 | A1 | first | 7/7 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | pass | — | 28/28 | 0 | 14 | 3 | 0.00 | — | 17.82 | 0 |
| A20 | B | first | 7/7 | 0.00 (360) | 0.00/148507337.19 (360) | -148507337.19 | — | bevel (see below) | 28/28 | 4 | 20 | 3 | 0.00 | 48 | 346.38 | 29 |
| A20 | A2 | rebuild | 7/7 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | — | 28/28 | 0 | 20 | 3 | 0.00 | 31 | 7.41 | 0 |
| A20 | A1 | rebuild | 7/7 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | pass | — | 28/28 | 0 | 14 | 3 | 0.00 | — | 9.43 | 0 |
| A20 | B | rebuild | 7/7 | 0.00 (360) | 0.00/145815054.52 (360) | -145815054.52 | — | bevel (see below) | 28/28 | 4 | 20 | 3 | 0.00 | 48 | 345.99 | 29 |
| X | A2 | first | 12/12 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | — | — | 48/48 | 0 | 40 | 3 | 0.00 | 51 | 30.81 | 0 |
| X | A1 | first | 12/12 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | pass | — | 48/48 | 0 | 24 | 3 | 0.00 | — | 31.57 | 0 |
| X | B | first | 12/12 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | pass | 48/48 | 0 | 40 | 3 | 0.00 | 107 | 850.01 | 78 |
| X | A2 | rebuild | 12/12 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | — | — | 48/48 | 0 | 40 | 3 | 0.00 | 51 | 15.84 | 0 |
| X | A1 | rebuild | 12/12 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | pass | — | 48/48 | 0 | 24 | 3 | 0.00 | — | 12.39 | 0 |
| X | B | rebuild | 12/12 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | pass | 48/48 | 0 | 40 | 3 | 0.00 | 105 | 853.16 | 76 |
| S1 | A2 | first | 7/7 | 0.00 (336) | 0.00/0.00 (336) | -0.00 | — | — | 28/28 | 0 | 20 | 3 | 0.00 | 31 | 16.39 | 0 |
| S1 | A1 | first | 7/7 | 0.00 (336) | 0.00/0.00 (336) | -0.00 | pass | — | 28/28 | 0 | 16 | 3 | 0.00 | — | 17.67 | 0 |
| S1 | B | first | NotExpressible: thin extrusion requires uniform centred thickness |
| S1 | A2 | rebuild | 7/7 | 0.00 (336) | 0.00/0.00 (336) | -0.00 | — | — | 28/28 | 0 | 20 | 3 | 0.00 | 31 | 12.75 | 0 |
| S1 | A1 | rebuild | 7/7 | 0.00 (336) | 0.00/0.00 (336) | -0.00 | pass | — | 28/28 | 0 | 16 | 3 | 0.00 | — | 11.45 | 0 |
| S1 | B | rebuild | NotExpressible: thin extrusion requires uniform centred thickness |
| S1b | A2 | first | 7/7 | 0.00 (336) | 0.00/0.00 (336) | -0.00 | — | — | 28/28 | 0 | 20 | 3 | 0.00 | 31 | 16.13 | 0 |
| S1b | A1 | first | 7/7 | 0.00 (336) | 0.00/0.00 (336) | -0.00 | pass | — | 28/28 | 0 | 16 | 3 | 0.00 | — | 18.31 | 0 |
| S1b | B | first | NotExpressible: thin extrusion requires uniform centred thickness |
| S1b | A2 | rebuild | 7/7 | 0.00 (336) | 0.00/0.00 (336) | -0.00 | — | — | 28/28 | 0 | 20 | 3 | 0.00 | 31 | 12.66 | 0 |
| S1b | A1 | rebuild | 7/7 | 0.00 (336) | 0.00/0.00 (336) | -0.00 | pass | — | 28/28 | 0 | 16 | 3 | 0.00 | — | 11.71 | 0 |
| S1b | B | rebuild | NotExpressible: thin extrusion requires uniform centred thickness |
| S2 | A2 | first | 9/9 | 0.00 (336) | 0.00/0.00 (336) | -0.00 | — | — | 36/36 | 0 | 28 | 3 | 0.00 | 39 | 21.73 | 0 |
| S2 | A1 | first | Vertex "a": UnresolvedJoint { boundaries: ["da", "ea"] }<br>Vertex "a": UnresolvedJoint { boundaries: ["da", "ea"] } |
| S2 | B | first | NotExpressible: thin extrusion requires uniform centred thickness |
| S2 | A2 | rebuild | 9/9 | 0.00 (336) | 0.00/0.00 (336) | -0.00 | — | — | 36/36 | 0 | 28 | 3 | 0.00 | 39 | 18.77 | 0 |
| S2 | A1 | rebuild | Vertex "a": UnresolvedJoint { boundaries: ["da", "ea"] }<br>Vertex "a": UnresolvedJoint { boundaries: ["da", "ea"] } |
| S2 | B | rebuild | NotExpressible: thin extrusion requires uniform centred thickness |
| S3 | A2 | first | 7/7 | 0.00 (336) | 0.00/0.00 (336) | -0.00 | — | — | 29/29 | 0 | 18 | 4 | 0.00 | 32 | 15.83 | 0 |
| S3 | A1 | first | 7/7 | 0.00 (336) | 0.00/0.00 (336) | -0.00 | pass | — | 29/29 | 0 | 14 | 4 | 0.00 | — | 18.77 | 0 |
| S3 | B | first | NotExpressible: thin extrusion requires uniform centred thickness |
| S3 | A2 | rebuild | 7/7 | 0.00 (336) | 0.00/0.00 (336) | -0.00 | — | — | 29/29 | 0 | 18 | 4 | 0.00 | 32 | 12.17 | 0 |
| S3 | A1 | rebuild | 7/7 | 0.00 (336) | 0.00/0.00 (336) | -0.00 | pass | — | 29/29 | 0 | 14 | 4 | 0.00 | — | 11.00 | 0 |
| S3 | B | rebuild | NotExpressible: thin extrusion requires uniform centred thickness |
| S4 | A2 | first | 7/7 | 0.00 (336) | 0.00/0.00 (336) | 0.00 | — | — | 30/30 | 0 | 20 | 16 | 0.00 | 44 | 17.70 | 0 |
| S4 | A1 | first | 7/7 | 0.00 (336) | 0.00/0.00 (336) | 0.00 | pass | — | 30/30 | 0 | 13 | 14 | 0.00 | — | 17.23 | 0 |
| S4 | B | first | NotExpressible: thin extrusion requires uniform centred thickness |
| S4 | A2 | rebuild | 7/7 | 0.00 (336) | 0.00/0.00 (336) | -0.00 | — | — | 30/30 | 0 | 20 | 16 | 0.00 | 44 | 14.63 | 0 |
| S4 | A1 | rebuild | 7/7 | 0.00 (336) | 0.00/0.00 (336) | -0.00 | pass | — | 30/30 | 0 | 13 | 14 | 0.00 | — | 11.09 | 0 |
| S4 | B | rebuild | NotExpressible: thin extrusion requires uniform centred thickness |
| S5 | A2 | first | 9/9 | 0.00 (240) | 0.00/0.00 (240) | -0.00 | — | — | 36/36 | 0 | 28 | 18 | 0.00 | 54 | 22.52 | 0 |
| S5 | A1 | first | Vertex "a": UnresolvedJoint { boundaries: ["da", "ea"] }<br>Vertex "a": UnresolvedJoint { boundaries: ["da", "ea"] } |
| S5 | B | first | NotExpressible: thin extrusion requires uniform centred thickness |
| S5 | A2 | rebuild | 9/9 | 0.00 (240) | 0.00/0.00 (240) | -0.00 | — | — | 36/36 | 0 | 28 | 18 | 0.00 | 54 | 18.85 | 0 |
| S5 | A1 | rebuild | Vertex "a": UnresolvedJoint { boundaries: ["da", "ea"] }<br>Vertex "a": UnresolvedJoint { boundaries: ["da", "ea"] } |
| S5 | B | rebuild | NotExpressible: thin extrusion requires uniform centred thickness |
| G | A2 | first | 9/9 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | — | 38/38 | 0 | 28 | 20 | 0.00 | 56 | 22.90 | 0 |
| G | A1 | first | 9/9 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | pass | — | 38/38 | 0 | 18 | 18 | 0.00 | — | 22.14 | 0 |
| G | B | first | NotExpressible: thin extrusion requires uniform centred thickness |
| G | A2 | rebuild | 9/9 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | — | — | 38/38 | 0 | 28 | 20 | 0.00 | 56 | 19.76 | 0 |
| G | A1 | rebuild | 9/9 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | pass | — | 38/38 | 0 | 18 | 18 | 0.00 | — | 15.77 | 0 |
| G | B | rebuild | NotExpressible: thin extrusion requires uniform centred thickness |
| F1 | A2 | first | 9/9 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | — | — | 36/36 | 0 | 28 | 3 | 0.00 | 39 | 21.56 | 0 |
| F1 | A1 | first | Vertex "a": UnresolvedJoint { boundaries: ["da", "ea"] }<br>Vertex "a": UnresolvedJoint { boundaries: ["da", "ea"] } |
| F1 | B | first | 9/9 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | pass | 36/36 | 0 | 28 | 3 | 0.00 | 55 | 393.88 | 34 |
| F1 | A2 | rebuild | 9/9 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | — | 36/36 | 0 | 28 | 3 | 0.00 | 39 | 17.94 | 0 |
| F1 | A1 | rebuild | Vertex "a": UnresolvedJoint { boundaries: ["da", "ea"] }<br>Vertex "a": UnresolvedJoint { boundaries: ["da", "ea"] } |
| F1 | B | rebuild | 9/9 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | pass | 36/36 | 0 | 28 | 3 | 0.00 | 57 | 434.92 | 36 |
| F2 | A2 | first | 9/9 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | — | — | 36/36 | 0 | 28 | 3 | 0.00 | 39 | 21.98 | 0 |
| F2 | A1 | first | Vertex "a": UnresolvedJoint { boundaries: ["da", "ea"] }<br>Vertex "a": UnresolvedJoint { boundaries: ["da", "ea"] } |
| F2 | B | first | 9/9 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | pass | 36/36 | 0 | 28 | 3 | 0.00 | 59 | 416.52 | 37 |
| F2 | A2 | rebuild | 9/9 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | — | 36/36 | 0 | 28 | 3 | 0.00 | 39 | 17.93 | 0 |
| F2 | A1 | rebuild | Vertex "a": UnresolvedJoint { boundaries: ["da", "ea"] }<br>Vertex "a": UnresolvedJoint { boundaries: ["da", "ea"] } |
| F2 | B | rebuild | 9/9 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | pass | 36/36 | 0 | 28 | 3 | 0.00 | 59 | 385.78 | 37 |
| F3 | A2 | first | 11/11 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | — | — | 44/44 | 0 | 36 | 3 | 0.00 | 47 | 28.49 | 0 |
| F3 | A1 | first | Vertex "a": UnresolvedJoint { boundaries: ["da", "ea"] }<br>Vertex "a": UnresolvedJoint { boundaries: ["ea", "fa"] }<br>Vertex "a": UnresolvedJoint { boundaries: ["ea", "fa"] } |
| F3 | B | first | 11/11 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | pass | 44/44 | 0 | 36 | 3 | 0.00 | 75 | 589.79 | 50 |
| F3 | A2 | rebuild | 11/11 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | — | — | 44/44 | 0 | 36 | 3 | 0.00 | 47 | 24.45 | 0 |
| F3 | A1 | rebuild | Vertex "a": UnresolvedJoint { boundaries: ["da", "ea"] }<br>Vertex "a": UnresolvedJoint { boundaries: ["ea", "fa"] }<br>Vertex "a": UnresolvedJoint { boundaries: ["ea", "fa"] } |
| F3 | B | rebuild | 11/11 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | pass | 44/44 | 0 | 36 | 3 | 0.00 | 77 | 613.85 | 52 |
| E | A2 | first | 9/9 | 0.00 (240) | 0.00/0.00 (240) | 0.00 | — | — | 36/36 | 0 | 28 | 3 | 0.00 | 39 | 21.72 | 0 |
| E | A1 | first | Vertex "a": UnresolvedJoint { boundaries: ["da", "ea"] }<br>Vertex "a": UnresolvedJoint { boundaries: ["da", "ea"] } |
| E | B | first | NotExpressible: thin extrusion requires uniform centred thickness |
| E | A2 | rebuild | 9/9 | 0.00 (240) | 0.00/0.00 (240) | -0.00 | — | — | 36/36 | 0 | 28 | 3 | 0.00 | 39 | 18.17 | 0 |
| E | A1 | rebuild | Vertex "a": UnresolvedJoint { boundaries: ["da", "ea"] }<br>Vertex "a": UnresolvedJoint { boundaries: ["da", "ea"] } |
| E | B | rebuild | NotExpressible: thin extrusion requires uniform centred thickness |
| Y1 | A2 | first | 6/6 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | — | 24/24 | 0 | 24 | 3 | 0.00 | 27 | 18.19 | 0 |
| Y1 | A1 | first | Vertex "a": UnresolvedJoint { boundaries: ["ab", "ca", "da"] }<br>Vertex "b": UnresolvedJoint { boundaries: ["bc", "ab", "db"] }<br>Vertex "c": UnresolvedJoint { boundaries: ["cd", "ca", "bc"] }<br>Vertex "c": UnresolvedJoint { boundaries: ["cd", "ca", "bc"] }<br>Vertex "d": UnresolvedJoint { boundaries: ["db", "da", "cd"] }<br>Vertex "d": UnresolvedJoint { boundaries: ["db", "da", "cd"] } |
| Y1 | B | first | 6/6 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | pass | 24/24 | 0 | 24 | 3 | 0.00 | 53 | 405.17 | 36 |
| Y1 | A2 | rebuild | 6/6 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | — | 24/24 | 0 | 24 | 3 | 0.00 | 27 | 18.19 | 0 |
| Y1 | A1 | rebuild | Vertex "a": UnresolvedJoint { boundaries: ["ab", "ca", "da"] }<br>Vertex "b": UnresolvedJoint { boundaries: ["bc", "ab", "db"] }<br>Vertex "c": UnresolvedJoint { boundaries: ["cd", "ca", "bc"] }<br>Vertex "c": UnresolvedJoint { boundaries: ["cd", "ca", "bc"] }<br>Vertex "d": UnresolvedJoint { boundaries: ["db", "da", "cd"] }<br>Vertex "d": UnresolvedJoint { boundaries: ["db", "da", "cd"] } |
| Y1 | B | rebuild | 6/6 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | — | pass | 24/24 | 0 | 24 | 3 | 0.00 | 69 | 568.38 | 52 |
| Y2 | A2 | first | 6/6 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | — | 24/24 | 0 | 24 | 3 | 0.00 | 27 | 18.94 | 0 |
| Y2 | A1 | first | Vertex "a": UnresolvedJoint { boundaries: ["ca", "da", "ab"] }<br>Vertex "b": UnresolvedJoint { boundaries: ["bc", "ab", "db"] }<br>Vertex "c": UnresolvedJoint { boundaries: ["cd", "ca", "bc"] }<br>Vertex "c": UnresolvedJoint { boundaries: ["cd", "ca", "bc"] }<br>Vertex "d": UnresolvedJoint { boundaries: ["db", "da", "cd"] }<br>Vertex "d": UnresolvedJoint { boundaries: ["db", "da", "cd"] } |
| Y2 | B | first | NotExpressible: thin extrusion requires uniform centred thickness |
| Y2 | A2 | rebuild | 6/6 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | — | 24/24 | 0 | 24 | 3 | 0.00 | 27 | 19.47 | 0 |
| Y2 | A1 | rebuild | Vertex "a": UnresolvedJoint { boundaries: ["ca", "da", "ab"] }<br>Vertex "b": UnresolvedJoint { boundaries: ["bc", "ab", "db"] }<br>Vertex "c": UnresolvedJoint { boundaries: ["cd", "ca", "bc"] }<br>Vertex "c": UnresolvedJoint { boundaries: ["cd", "ca", "bc"] }<br>Vertex "d": UnresolvedJoint { boundaries: ["db", "da", "cd"] }<br>Vertex "d": UnresolvedJoint { boundaries: ["db", "da", "cd"] } |
| Y2 | B | rebuild | NotExpressible: thin extrusion requires uniform centred thickness |
| YN | A2 | first | 6/6 | 0.00 (240) | 0.00/0.00 (240) | -0.00 | — | — | 24/24 | 0 | 24 | 3 | 0.00 | 27 | 19.73 | 0 |
| YN | A1 | first | Vertex "a": UnresolvedJoint { boundaries: ["ab", "ca", "da"] }<br>Vertex "b": UnresolvedJoint { boundaries: ["bc", "ab", "db"] }<br>Vertex "c": UnresolvedJoint { boundaries: ["cd", "ca", "bc"] }<br>Vertex "c": UnresolvedJoint { boundaries: ["cd", "ca", "bc"] }<br>Vertex "d": UnresolvedJoint { boundaries: ["db", "da", "cd"] }<br>Vertex "d": UnresolvedJoint { boundaries: ["db", "da", "cd"] } |
| YN | B | first | NotExpressible: thin extrusion requires uniform centred thickness |
| YN | A2 | rebuild | 6/6 | 0.00 (240) | 0.00/0.00 (240) | 0.00 | — | — | 24/24 | 0 | 24 | 3 | 0.00 | 27 | 18.06 | 0 |
| YN | A1 | rebuild | Vertex "a": UnresolvedJoint { boundaries: ["ab", "ca", "da"] }<br>Vertex "b": UnresolvedJoint { boundaries: ["bc", "ab", "db"] }<br>Vertex "c": UnresolvedJoint { boundaries: ["cd", "ca", "bc"] }<br>Vertex "c": UnresolvedJoint { boundaries: ["cd", "ca", "bc"] }<br>Vertex "d": UnresolvedJoint { boundaries: ["db", "da", "cd"] }<br>Vertex "d": UnresolvedJoint { boundaries: ["db", "da", "cd"] } |
| YN | B | rebuild | NotExpressible: thin extrusion requires uniform centred thickness |
| Q | A2 | first | 8/8 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | — | — | 32/32 | 0 | 32 | 3 | 0.00 | 35 | 24.80 | 0 |
| Q | A1 | first | Vertex "a": UnresolvedJoint { boundaries: ["ab", "ca", "da", "ea"] }<br>Vertex "b": UnresolvedJoint { boundaries: ["bc", "ab", "eb"] }<br>Vertex "c": UnresolvedJoint { boundaries: ["cd", "ca", "bc"] }<br>Vertex "c": UnresolvedJoint { boundaries: ["cd", "ca", "bc"] }<br>Vertex "d": UnresolvedJoint { boundaries: ["cd", "de", "da"] }<br>Vertex "d": UnresolvedJoint { boundaries: ["cd", "de", "da"] }<br>Vertex "e": UnresolvedJoint { boundaries: ["eb", "ea", "de"] }<br>Vertex "e": UnresolvedJoint { boundaries: ["eb", "ea", "de"] } |
| Q | B | first | 8/8 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | — | pass | 32/32 | 0 | 32 | 3 | 0.00 | 75 | 649.60 | 54 |
| Q | A2 | rebuild | 8/8 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | — | 32/32 | 0 | 32 | 3 | 0.00 | 35 | 21.52 | 0 |
| Q | A1 | rebuild | Vertex "a": UnresolvedJoint { boundaries: ["ab", "ca", "da", "ea"] }<br>Vertex "b": UnresolvedJoint { boundaries: ["bc", "ab", "eb"] }<br>Vertex "c": UnresolvedJoint { boundaries: ["cd", "ca", "bc"] }<br>Vertex "c": UnresolvedJoint { boundaries: ["cd", "ca", "bc"] }<br>Vertex "d": UnresolvedJoint { boundaries: ["cd", "de", "da"] }<br>Vertex "d": UnresolvedJoint { boundaries: ["cd", "de", "da"] }<br>Vertex "e": UnresolvedJoint { boundaries: ["eb", "ea", "de"] }<br>Vertex "e": UnresolvedJoint { boundaries: ["eb", "ea", "de"] } |
| Q | B | rebuild | 8/8 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | pass | 32/32 | 0 | 32 | 3 | 0.00 | 74 | 648.50 | 53 |
| Z | A2 | first | 5/5 | 0.00 (288) | 0.00/0.00 (288) | -0.00 | — | — | 21/21 | 0 | 14 | 4 | 0.00 | 24 | 12.78 | 0 |
| Z | A1 | first | Vertex "d": UnresolvedJoint { boundaries: ["da", "bd", "cd"] }<br>Vertex "b": UnresolvedJoint { boundaries: ["bc", "bd", "ab"] }<br>Vertex "b": UnresolvedJoint { boundaries: ["bc", "bd", "ab"] }<br>Vertex "b": UnresolvedJoint { boundaries: ["bc", "bd", "ab"] }<br>Vertex "d": UnresolvedJoint { boundaries: ["da", "bd", "cd"] } |
| Z | B | first | NotExpressible: thin extrusion requires uniform centred thickness |
| Z | A2 | rebuild | 5/5 | 0.00 (288) | 0.00/0.00 (288) | 0.00 | — | — | 21/21 | 0 | 14 | 4 | 0.00 | 24 | 13.32 | 0 |
| Z | A1 | rebuild | Vertex "d": UnresolvedJoint { boundaries: ["da", "bd", "cd"] }<br>Vertex "b": UnresolvedJoint { boundaries: ["bc", "bd", "ab"] }<br>Vertex "b": UnresolvedJoint { boundaries: ["bc", "bd", "ab"] }<br>Vertex "b": UnresolvedJoint { boundaries: ["bc", "bd", "ab"] }<br>Vertex "d": UnresolvedJoint { boundaries: ["da", "bd", "cd"] } |
| Z | B | rebuild | NotExpressible: thin extrusion requires uniform centred thickness |

```text
P30 A2 first: 20 joint faces: ab#1→be, ab#3→fa, ab#5→bc, be#1→ef, be#3→ab, be#4→bc, be#6→de, ef#1→fa, ef#3→be, ef#4→de, fa#1→ab, fa#3→ef, bc#1→cd, bc#3→be, bc#4→ab, cd#1→de, cd#3→bc, de#1→be, de#3→cd, de#5→ef
P30 A2 first: 0 foreign pieces, 0 leaking faces
P30 A1 first: 14 joint faces: ab#1→bc, ab#3→fa, be#1→ef+de, be#3→bc+ab, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, de#1→ef, de#3→cd
P30 A1 first: 0 foreign pieces, 0 leaking faces
P30 A1 first ab#2 → room0 [0.000, 3700.000]
P30 A1 first ef#2 → room0 [279.904, 3979.904]
P30 A1 first bc#2 → room1 [279.904, 3979.904]
P30 A1 first de#2 → room1 [0.000, 3700.000]
P30 B first: 28 splits, 29 fragments
P30 B first: 20 joint faces: ab#1→fa, ab#5→bc, ab#6→be, be#1→ab, be#3→bc, be#4→de, be#5→ef, ef#3→de, ef#4→be, ef#6→fa, fa#4→ef, fa#5→ab, bc#1→ab, bc#4→be, bc#6→cd, cd#4→bc, cd#5→de, de#4→cd, de#5→be, de#6→ef
P30 B first: 0 foreign pieces, 0 leaking faces
P30 A2 rebuild: 20 joint faces: ab#1→be, ab#3→fa, ab#5→bc, be#1→ef, be#3→ab, be#4→bc, be#6→de, ef#1→fa, ef#3→be, ef#4→de, fa#1→ab, fa#3→ef, bc#1→cd, bc#3→be, bc#4→ab, cd#1→de, cd#3→bc, de#1→be, de#3→cd, de#5→ef
P30 A2 rebuild: 0 foreign pieces, 0 leaking faces
P30 A1 rebuild: 14 joint faces: ab#1→bc, ab#3→fa, be#1→ef+de, be#3→bc+ab, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, de#1→ef, de#3→cd
P30 A1 rebuild: 0 foreign pieces, 0 leaking faces
P30 A1 rebuild ab#2 → room0 [0.000, 3413.946]
P30 A1 rebuild ef#2 → room0 [279.904, 3978.850]
P30 A1 rebuild bc#2 → room1 [279.904, 3979.904]
P30 A1 rebuild de#2 → room1 [0.000, 3700.000]
P30 B rebuild: 28 splits, 29 fragments
P30 B rebuild: 20 joint faces: ab#1→fa, ab#5→bc, ab#6→be, be#1→ab, be#3→bc, be#4→de, be#5→ef, ef#3→de, ef#4→be, ef#6→fa, fa#4→ef, fa#5→ab, bc#2→ab, bc#4→be, bc#6→cd, cd#4→bc, cd#5→de, de#4→cd, de#5→be, de#6→ef
P30 B rebuild: 0 foreign pieces, 0 leaking faces
P45 A2 first: 20 joint faces: ab#1→be, ab#3→fa, ab#5→bc, be#1→ef, be#3→ab, be#4→bc, be#6→de, ef#1→fa, ef#3→be, ef#4→de, fa#1→ab, fa#3→ef, bc#1→cd, bc#3→be, bc#4→ab, cd#1→de, cd#3→bc, de#1→be, de#3→cd, de#5→ef
P45 A2 first: 0 foreign pieces, 0 leaking faces
P45 A1 first: 14 joint faces: ab#1→bc, ab#3→fa, be#1→ef+de, be#3→bc+ab, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, de#1→ef, de#3→cd
P45 A1 first: 0 foreign pieces, 0 leaking faces
P45 A1 first ab#2 → room0 [0.000, 3787.868]
P45 A1 first ef#2 → room0 [181.066, 3968.934]
P45 A1 first bc#2 → room1 [181.066, 3968.934]
P45 A1 first de#2 → room1 [0.000, 3787.868]
P45 B first: 30 splits, 31 fragments
P45 B first: 20 joint faces: ab#1→fa, ab#5→bc, ab#6→be, be#0→ef, be#3→bc, be#4→ab, be#7→de, ef#3→de, ef#4→be, ef#5→fa, fa#4→ef, fa#5→ab, bc#1→ab, bc#4→be, bc#6→cd, cd#4→bc, cd#5→de, de#4→cd, de#5→be, de#6→ef
P45 B first: 0 foreign pieces, 0 leaking faces
P45 A2 rebuild: 20 joint faces: ab#1→be, ab#3→fa, ab#5→bc, be#1→ef, be#3→ab, be#4→bc, be#6→de, ef#1→fa, ef#3→be, ef#4→de, fa#1→ab, fa#3→ef, bc#1→cd, bc#3→be, bc#4→ab, cd#1→de, cd#3→bc, de#1→be, de#3→cd, de#5→ef
P45 A2 rebuild: 0 foreign pieces, 0 leaking faces
P45 A1 rebuild: 14 joint faces: ab#1→bc, ab#3→fa, be#1→ef+de, be#3→bc+ab, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, de#1→ef, de#3→cd
P45 A1 rebuild: 0 foreign pieces, 0 leaking faces
P45 A1 rebuild ab#2 → room0 [0.000, 3500.532]
P45 A1 rebuild ef#2 → room0 [181.066, 3966.598]
P45 A1 rebuild bc#2 → room1 [181.066, 3968.934]
P45 A1 rebuild de#2 → room1 [0.000, 3787.868]
P45 B rebuild: 30 splits, 31 fragments
P45 B rebuild: 20 joint faces: ab#1→fa, ab#5→bc, ab#6→be, be#1→de, be#2→ef, be#5→bc, be#6→ab, ef#3→de, ef#4→be, ef#6→fa, fa#4→ef, fa#5→ab, bc#2→ab, bc#4→be, bc#6→cd, cd#4→bc, cd#5→de, de#4→cd, de#5→be, de#6→ef
P45 B rebuild: 0 foreign pieces, 0 leaking faces
P60 A2 first: 20 joint faces: ab#1→be, ab#3→fa, ab#5→bc, be#1→ef, be#3→ab, be#4→bc, be#6→de, ef#1→fa, ef#3→be, ef#4→de, fa#1→ab, fa#3→ef, bc#1→cd, bc#3→be, bc#4→ab, cd#1→de, cd#3→bc, de#1→be, de#3→cd, de#5→ef
P60 A2 first: 0 foreign pieces, 0 leaking faces
P60 A1 first: 14 joint faces: ab#1→bc, ab#3→fa, be#1→ef+de, be#3→bc+ab, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, de#1→ef, de#3→cd
P60 A1 first: 0 foreign pieces, 0 leaking faces
P60 A1 first ab#2 → room0 [0.000, 3826.795]
P60 A1 first ef#2 → room0 [129.904, 3956.699]
P60 A1 first bc#2 → room1 [129.904, 3956.699]
P60 A1 first de#2 → room1 [0.000, 3826.795]
P60 B first: 22 splits, 23 fragments
P60 B first: 20 joint faces: ab#1→fa, ab#5→bc, ab#6→be, be#1→ab, be#3→bc, be#4→ef, be#5→de, ef#4→be, ef#5→de, ef#6→fa, fa#4→ab, fa#5→ef, bc#3→cd, bc#5→ab, bc#6→be, cd#1→bc, cd#4→de, de#4→cd, de#5→ef, de#6→be
P60 B first: 0 foreign pieces, 0 leaking faces
P60 A2 rebuild: 20 joint faces: ab#1→be, ab#3→fa, ab#5→bc, be#1→ef, be#3→ab, be#4→bc, be#6→de, ef#1→fa, ef#3→be, ef#4→de, fa#1→ab, fa#3→ef, bc#1→cd, bc#3→be, bc#4→ab, cd#1→de, cd#3→bc, de#1→be, de#3→cd, de#5→ef
P60 A2 rebuild: 0 foreign pieces, 0 leaking faces
P60 A1 rebuild: 14 joint faces: ab#1→bc, ab#3→fa, be#1→ef+de, be#3→bc+ab, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, de#1→ef, de#3→cd
P60 A1 rebuild: 0 foreign pieces, 0 leaking faces
P60 A1 rebuild ab#2 → room0 [0.000, 3537.791]
P60 A1 rebuild ef#2 → room0 [129.904, 3952.695]
P60 A1 rebuild bc#2 → room1 [129.904, 3956.699]
P60 A1 rebuild de#2 → room1 [0.000, 3826.795]
P60 B rebuild: 22 splits, 23 fragments
P60 B rebuild: 20 joint faces: ab#1→fa, ab#5→bc, ab#6→be, be#1→ab, be#3→bc, be#4→ef, be#5→de, ef#4→be, ef#5→de, ef#6→fa, fa#4→ab, fa#5→ef, bc#3→cd, bc#5→ab, bc#6→be, cd#1→bc, cd#4→de, de#4→cd, de#5→ef, de#6→be
P60 B rebuild: 0 foreign pieces, 0 leaking faces
W A2 first: 20 joint faces: ab#1→be, ab#3→fa, ab#5→bc, be#1→ef, be#3→ab, be#4→bc, be#6→de, ef#1→fa, ef#3→be, ef#4→de, fa#1→ab, fa#3→ef, bc#1→cd, bc#3→be, bc#4→ab, cd#1→de, cd#3→bc, de#1→be, de#3→cd, de#5→ef
W A2 first: 0 foreign pieces, 0 leaking faces
W A1 first: 14 joint faces: ab#1→bc, ab#3→fa, be#1→ef+de, be#3→bc+ab, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, de#1→ef, de#3→cd
W A1 first: 0 foreign pieces, 0 leaking faces
W A1 first ab#2 → room0 [0.000, 3826.795]
W A1 first ef#2 → room0 [129.904, 3956.699]
W A1 first bc#2 → room1 [129.904, 3956.699]
W A1 first de#2 → room1 [0.000, 3826.795]
W B first: 22 splits, 23 fragments
W B first: 20 joint faces: ab#1→fa, ab#5→bc, ab#6→be, be#1→ab, be#3→bc, be#4→ef, be#5→de, ef#4→be, ef#5→de, ef#6→fa, fa#4→ab, fa#5→ef, bc#3→cd, bc#5→ab, bc#6→be, cd#1→bc, cd#4→de, de#4→cd, de#5→ef, de#6→be
W B first: 0 foreign pieces, 0 leaking faces
W A2 rebuild: 20 joint faces: ab#1→be, ab#3→fa, ab#5→bc, be#1→ef, be#3→ab, be#4→bc, be#6→de, ef#1→fa, ef#3→be, ef#4→de, fa#1→ab, fa#3→ef, bc#1→cd, bc#3→be, bc#4→ab, cd#1→de, cd#3→bc, de#1→be, de#3→cd, de#5→ef
W A2 rebuild: 0 foreign pieces, 0 leaking faces
W A1 rebuild: 14 joint faces: ab#1→bc, ab#3→fa, be#1→ef+de, be#3→bc+ab, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, de#1→ef, de#3→cd
W A1 rebuild: 0 foreign pieces, 0 leaking faces
W A1 rebuild ab#2 → room0 [0.000, 3537.791]
W A1 rebuild ef#2 → room0 [129.904, 3952.695]
W A1 rebuild bc#2 → room1 [129.904, 3956.699]
W A1 rebuild de#2 → room1 [0.000, 3826.795]
W B rebuild: 22 splits, 23 fragments
W B rebuild: 20 joint faces: ab#1→fa, ab#5→bc, ab#6→be, be#1→ab, be#3→bc, be#4→ef, be#5→de, ef#4→be, ef#5→de, ef#6→fa, fa#4→ab, fa#5→ef, bc#3→cd, bc#5→ab, bc#6→be, cd#1→bc, cd#4→de, de#4→cd, de#5→ef, de#6→be
W B rebuild: 0 foreign pieces, 0 leaking faces
A20 A2 first: 20 joint faces: ab#1→be, ab#3→fa, ab#5→bc, be#1→ef, be#3→ab, be#4→bc, be#6→de, ef#1→fa, ef#3→be, ef#4→de, fa#1→ab, fa#3→ef, bc#1→cd, bc#3→be, bc#4→ab, cd#1→de, cd#3→bc, de#1→be, de#3→cd, de#5→ef
A20 A2 first: 0 foreign pieces, 0 leaking faces
A20 A1 first: 14 joint faces: ab#1→bc, ab#3→fa, be#2→bc+ab, be#5→ef+de, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, de#1→ef, de#3→cd
A20 A1 first: 0 foreign pieces, 0 leaking faces
A20 A1 first ab#2 → room0 [0.000, 3561.429]
A20 A1 first ef#2 → room0 [425.346, 3986.775]
A20 A1 first bc#2 → room1 [425.346, 3986.775]
A20 A1 first de#2 → room1 [0.000, 3561.429]
A20 B first: mitre deficit 148507337.19 mm³, uncovered 418.884173 mm; bevel excess / deficit 0 / 0 mm³.
A20 B first: 28 splits, 29 fragments
A20 B first: 20 joint faces: ab#5→be, ab#6→fa, ab#7→bc, be#0→ab, be#1→bc, be#5→ef, be#6→de, ef#3→de, ef#5→be, ef#6→fa, fa#4→ef, fa#6→ab, bc#1→ab, bc#4→be, bc#6→cd, cd#5→de, cd#6→bc, de#5→be, de#6→cd, de#7→ef
A20 B first: 0 foreign pieces, 0 leaking faces
A20 A2 rebuild: 20 joint faces: ab#1→be, ab#3→fa, ab#5→bc, be#1→ef, be#3→ab, be#4→bc, be#6→de, ef#1→fa, ef#3→be, ef#4→de, fa#1→ab, fa#3→ef, bc#1→cd, bc#3→be, bc#4→ab, cd#1→de, cd#3→bc, de#1→be, de#3→cd, de#5→ef
A20 A2 rebuild: 0 foreign pieces, 0 leaking faces
A20 A1 rebuild: 14 joint faces: ab#1→bc, ab#3→fa, be#2→bc+ab, be#5→ef+de, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, de#1→ef, de#3→cd
A20 A1 rebuild: 0 foreign pieces, 0 leaking faces
A20 A1 rebuild ab#2 → room0 [0.000, 3275.962]
A20 A1 rebuild ef#2 → room0 [425.346, 3986.308]
A20 A1 rebuild bc#2 → room1 [425.346, 3986.775]
A20 A1 rebuild de#2 → room1 [0.000, 3561.429]
A20 B rebuild: mitre deficit 145815054.52 mm³, uncovered 418.884173 mm; bevel excess / deficit 0 / 0 mm³.
A20 B rebuild: 28 splits, 29 fragments
A20 B rebuild: 20 joint faces: ab#5→be, ab#6→fa, ab#7→bc, be#0→ab, be#1→bc, be#5→ef, be#6→de, ef#3→de, ef#5→be, ef#6→fa, fa#4→ef, fa#6→ab, bc#2→ab, bc#4→be, bc#6→cd, cd#5→de, cd#6→bc, de#5→be, de#6→cd, de#7→ef
A20 B rebuild: 0 foreign pieces, 0 leaking faces
X A2 first: 40 joint faces: ab#1→bc, ab#3→da, ab#4→ha, ab#6→ib, bc#1→cd, bc#3→ab, bc#4→ib, cd#1→da, cd#3→bc, cd#5→de, da#1→ab, da#3→cd, da#4→de, da#6→fa, de#1→ef, de#3→da, de#4→cd, ef#1→fa, ef#3→de, ef#5→fg, fa#1→da, fa#3→ef, fa#4→fg, fa#6→ha, fg#1→gh, fg#3→fa, fg#4→ef, gh#1→ha, gh#3→fg, gh#5→hi, ha#1→fa, ha#3→gh, ha#4→hi, ha#6→ab, hi#1→ib, hi#3→ha, hi#4→gh, ib#1→ab, ib#3→hi, ib#5→bc
X A2 first: 0 foreign pieces, 0 leaking faces
X A1 first: 24 joint faces: ab#1→bc+ib, ab#3→fa, bc#1→cd, bc#3→ib, cd#1→de, cd#3→bc, da#1→ab+fa, da#3→de+cd, de#1→ef, de#3→cd, ef#1→fg, ef#3→de, fa#1→ab, fa#3→fg+ef, fg#1→gh, fg#3→ef, gh#1→hi, gh#3→fg, ha#1→fa+ab, ha#3→hi+gh, hi#1→ib, hi#3→gh, ib#1→bc, ib#3→hi
X A1 first: 0 foreign pieces, 0 leaking faces
X A1 first ab#2 → room0 [75.000, 4925.000]
X A1 first ab#4 → room3 [0.000, 4893.934]
X A1 first bc#2 → room0 [75.000, 2925.000]
X A1 first cd#2 → room0 [0.000, 4850.000]
X A1 first de#2 → room1 [75.000, 4925.000]
X A1 first ef#2 → room1 [0.000, 2850.000]
X A1 first fa#2 → room1 [0.000, 4850.000]
X A1 first fa#4 → room2 [181.066, 4925.000]
X A1 first fg#2 → room2 [75.000, 2925.000]
X A1 first gh#2 → room2 [0.000, 1893.934]
X A1 first hi#2 → room3 [181.066, 7925.000]
X A1 first ib#2 → room3 [0.000, 2850.000]
X B first: 77 splits, 78 fragments
X B first: 40 joint faces: ab#0→ib, ab#1→bc, ab#4→ha, ab#6→da, bc#1→ab, bc#5→ib, bc#6→cd, cd#3→bc, cd#5→de, cd#6→da, da#3→cd, da#4→fa, da#5→ab, da#7→de, de#1→da, de#2→cd, de#6→ef, ef#1→de, ef#4→fg, ef#6→fa, fa#3→da, fa#4→ha, fa#5→ef, fa#6→fg, fg#4→fa, fg#5→ef, fg#6→gh, gh#3→hi, gh#4→ha, gh#5→fg, ha#1→gh, ha#2→hi, ha#4→ab, ha#5→fa, hi#4→ha, hi#5→gh, hi#6→ib, ib#3→bc, ib#4→ab, ib#6→hi
X B first: 0 foreign pieces, 0 leaking faces
X A2 rebuild: 40 joint faces: ab#1→bc, ab#3→da, ab#4→ha, ab#6→ib, bc#1→cd, bc#3→ab, bc#4→ib, cd#1→da, cd#3→bc, cd#5→de, da#1→ab, da#3→cd, da#4→de, da#6→fa, de#1→ef, de#3→da, de#4→cd, ef#1→fa, ef#3→de, ef#5→fg, fa#1→da, fa#3→ef, fa#4→fg, fa#6→ha, fg#1→gh, fg#3→fa, fg#4→ef, gh#1→ha, gh#3→fg, gh#5→hi, ha#1→fa, ha#3→gh, ha#4→hi, ha#6→ab, hi#1→ib, hi#3→ha, hi#4→gh, ib#1→ab, ib#3→hi, ib#5→bc
X A2 rebuild: 0 foreign pieces, 0 leaking faces
X A1 rebuild: 24 joint faces: ab#1→bc+ib, ab#3→fa, bc#1→cd, bc#3→ib, cd#1→de, cd#3→bc, da#1→ab+fa, da#3→de+cd, de#1→ef, de#3→cd, ef#1→fg, ef#3→de, fa#1→ab, fa#3→fg+ef, fg#1→gh, fg#3→ef, gh#1→hi, gh#3→fg, ha#2→hi+gh, ha#5→fa+ab, hi#1→ib, hi#3→gh, ib#1→bc, ib#3→hi
X A1 rebuild: 0 foreign pieces, 0 leaking faces
X A1 rebuild ab#2 → room0 [75.000, 4925.000]
X A1 rebuild ab#4 → room3 [0.000, 4891.598]
X A1 rebuild bc#2 → room0 [75.000, 2925.000]
X A1 rebuild cd#2 → room0 [0.000, 4850.000]
X A1 rebuild de#2 → room1 [75.000, 4925.000]
X A1 rebuild ef#2 → room1 [0.000, 2850.000]
X A1 rebuild fa#2 → room1 [0.000, 4850.000]
X A1 rebuild fa#4 → room2 [168.402, 4925.000]
X A1 rebuild fg#2 → room2 [75.000, 2925.000]
X A1 rebuild gh#2 → room2 [0.000, 2191.598]
X A1 rebuild hi#2 → room3 [168.402, 7625.000]
X A1 rebuild ib#2 → room3 [0.000, 2850.000]
X B rebuild: 75 splits, 76 fragments
X B rebuild: 40 joint faces: ab#0→ib, ab#1→bc, ab#4→ha, ab#6→da, bc#1→ab, bc#5→ib, bc#6→cd, cd#1→bc, cd#5→de, cd#6→da, da#3→cd, da#4→fa, da#5→ab, da#7→de, de#1→da, de#2→cd, de#6→ef, ef#1→de, ef#4→fg, ef#6→fa, fa#1→da, fa#2→ha, fa#6→fg, fa#7→ef, fg#1→fa, fg#5→ef, fg#6→gh, gh#2→fg, gh#3→hi, gh#6→ha, ha#2→ab, ha#3→fa, ha#6→gh, ha#7→hi, hi#4→ha, hi#5→gh, hi#6→ib, ib#3→bc, ib#4→ab, ib#6→hi
X B rebuild: 0 foreign pieces, 0 leaking faces
S1 A2 first: 20 joint faces: ab#1→bc, ab#3→da, ab#4→fa, bc#1→cd, bc#3→ab, cd#1→da, cd#3→bc, cd#5→de, da#1→ab, da#3→cd, da#4→de, da#6→fa, de#1→ef, de#3→da, de#4→cd, ef#1→fa, ef#3→de, fa#1→da, fa#3→ef, fa#5→ab
S1 A2 first: 0 foreign pieces, 0 leaking faces
S1 A1 first: 16 joint faces: ab#1→bc, ab#3→fa+da, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, da#1→ab, da#3→de+cd, da#5→fa, da#6→ab, de#1→ef, de#3→cd, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef
S1 A1 first: 0 foreign pieces, 0 leaking faces
S1 A1 first ab#2 → room0 [75.000, 7925.000]
S1 A1 first cd#2 → room0 [0.000, 7850.000]
S1 A1 first de#2 → room1 [75.000, 7925.000]
S1 A1 first fa#2 → room1 [0.000, 7850.000]
S1 A2 rebuild: 20 joint faces: ab#1→bc, ab#3→da, ab#4→fa, bc#1→cd, bc#3→ab, cd#1→da, cd#3→bc, cd#5→de, da#1→ab, da#3→cd, da#4→de, da#6→fa, de#1→ef, de#3→da, de#4→cd, ef#1→fa, ef#3→de, fa#1→da, fa#3→ef, fa#5→ab
S1 A2 rebuild: 0 foreign pieces, 0 leaking faces
S1 A1 rebuild: 16 joint faces: ab#1→bc, ab#3→fa+da, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, da#1→ab, da#3→de+cd, da#5→fa, da#6→ab, de#1→ef, de#3→cd, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef
S1 A1 rebuild: 0 foreign pieces, 0 leaking faces
S1 A1 rebuild ab#2 → room0 [65.374, 7625.000]
S1 A1 rebuild cd#2 → room0 [0.000, 7842.126]
S1 A1 rebuild de#2 → room1 [67.874, 7925.000]
S1 A1 rebuild fa#2 → room1 [0.000, 8145.626]
S1b A2 first: 20 joint faces: ab#1→bc, ab#3→da, ab#4→fa, bc#1→cd, bc#3→ab, cd#1→da, cd#3→bc, cd#5→de, da#1→ab, da#3→cd, da#4→de, da#6→fa, de#1→ef, de#3→da, de#4→cd, ef#1→fa, ef#3→de, fa#1→da, fa#3→ef, fa#5→ab
S1b A2 first: 0 foreign pieces, 0 leaking faces
S1b A1 first: 16 joint faces: ab#1→bc, ab#3→fa+da, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, da#1→ab, da#3→de+cd, da#5→fa, da#6→ab, de#1→ef, de#3→cd, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef
S1b A1 first: 0 foreign pieces, 0 leaking faces
S1b A1 first ab#2 → room0 [144.338, 7925.000]
S1b A1 first cd#2 → room0 [0.000, 6149.648]
S1b A1 first de#2 → room1 [129.904, 9657.051]
S1b A1 first fa#2 → room1 [0.000, 7861.491]
S1b A2 rebuild: 20 joint faces: ab#1→bc, ab#3→da, ab#4→fa, bc#1→cd, bc#3→ab, cd#1→da, cd#3→bc, cd#5→de, da#1→ab, da#3→cd, da#4→de, da#6→fa, de#1→ef, de#3→da, de#4→cd, ef#1→fa, ef#3→de, fa#1→da, fa#3→ef, fa#5→ab
S1b A2 rebuild: 0 foreign pieces, 0 leaking faces
S1b A1 rebuild: 16 joint faces: ab#1→bc, ab#3→fa+da, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, da#1→ab, da#3→de+cd, da#5→fa, da#6→ab, de#1→ef, de#3→cd, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef
S1b A1 rebuild: 0 foreign pieces, 0 leaking faces
S1b A1 rebuild ab#2 → room0 [130.842, 7625.000]
S1b A1 rebuild cd#2 → room0 [0.000, 6145.644]
S1b A1 rebuild de#2 → room1 [118.908, 9657.051]
S1b A1 rebuild fa#2 → room1 [0.000, 8160.987]
S2 A2 first: 28 joint faces: ab#1→bc, ab#3→da, ab#4→ga, bc#1→cd, bc#3→ab, cd#1→da, cd#3→bc, cd#5→de, da#1→ab, da#3→cd, da#4→de, da#6→ea, de#1→ea, de#3→da, de#4→cd, de#6→ef, ea#1→da, ea#3→de, ea#4→ef, ea#6→ga, ef#1→fg, ef#3→ea, ef#4→de, fg#1→ga, fg#3→ef, ga#1→ea, ga#3→fg, ga#5→ab
S2 A2 first: 0 foreign pieces, 0 leaking faces
S2 A2 rebuild: 28 joint faces: ab#1→bc, ab#3→da, ab#4→ga, bc#1→cd, bc#3→ab, cd#1→da, cd#3→bc, cd#5→de, da#1→ab, da#3→cd, da#4→de, da#6→ea, de#1→ea, de#3→da, de#4→cd, de#6→ef, ea#1→da, ea#3→de, ea#4→ef, ea#6→ga, ef#1→fg, ef#3→ea, ef#4→de, fg#1→ga, fg#3→ef, ga#1→ea, ga#3→fg, ga#5→ab
S2 A2 rebuild: 0 foreign pieces, 0 leaking faces
S3 A2 first: 18 joint faces: ab#1→bc, bc#1→cd, bc#3→ab, cd#1→da, cd#3→bc, cd#5→de, da#1→ab, da#3→cd, da#4→de, da#6→fa, de#1→ef, de#3→da, de#4→cd, ef#1→fa, ef#3→de, fa#1→da, fa#3→ef, fa#5→ab
S3 A2 first: 0 foreign pieces, 0 leaking faces
S3 A2 first ab#3 → room0 [186.603, 200.000]
S3 A1 first: 14 joint faces: ab#1→bc, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, da#1→ab, da#3→de+cd, da#5→fa, de#1→ef, de#3→cd, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef
S3 A1 first: 0 foreign pieces, 0 leaking faces
S3 A1 first ab#3 → room0 [186.603, 200.000]
S3 A1 first cd#2 → room0 [0.000, 12841.249]
S3 A1 first de#2 → room1 [20.096, 2728.848]
S3 A1 first fa#2 → room1 [0.000, 7705.718]
S3 A2 rebuild: 18 joint faces: ab#1→bc, bc#1→cd, bc#3→ab, cd#1→da, cd#3→bc, cd#5→de, da#1→ab, da#3→cd, da#4→de, da#6→fa, de#1→ef, de#3→da, de#4→cd, ef#1→fa, ef#3→de, fa#1→da, fa#3→ef, fa#5→ab
S3 A2 rebuild: 0 foreign pieces, 0 leaking faces
S3 A2 rebuild ab#3 → room0 [185.445, 200.000]
S3 A1 rebuild: 14 joint faces: ab#1→bc, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, da#1→ab, da#3→de+cd, da#5→fa, de#1→ef, de#3→cd, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef
S3 A1 rebuild: 0 foreign pieces, 0 leaking faces
S3 A1 rebuild ab#3 → room0 [185.445, 200.000]
S3 A1 rebuild cd#2 → room0 [0.000, 12827.208]
S3 A1 rebuild de#2 → room1 [19.136, 2728.848]
S3 A1 rebuild fa#2 → room1 [0.000, 7995.178]
S4 A2 first: 20 joint faces: ab#1→bc, ab#3→da, ab#4→fa, bc#1→cd, bc#3→ab, cd#1→da, cd#3→bc, cd#5→de, da#1→ab, da#3→cd, da#4→de, da#6→fa, de#1→ef, de#3→da, de#4→cd, ef#1→fa, ef#3→de, fa#3→ef, fa#5→ab, fa#6→da
S4 A2 first: 0 foreign pieces, 0 leaking faces
S4 A1 first: 13 joint faces: ab#1→bc, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, da#1→ab, da#3→de+cd, de#1→ef, de#3→cd, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef
S4 A1 first: 2 foreign pieces, 1 leaking faces
S4 A1 first ab#2 → room1 [0.000, 23.205] (not a side role) + room0 [323.205, 7925.000]
S4 A1 first ab#3 → room1 [140.000, 200.000] (not a side role)
S4 A1 first cd#2 → room0 [0.000, 2708.751]
S4 A1 first de#2 → room1 [279.904, 13121.152]
S4 A1 first leak ab#2 Room { room: RoomId("room0") } colour on Room { room: RoomId("room1") } strip 23.205 mm
S4 A2 rebuild: 20 joint faces: ab#1→bc, ab#3→da, ab#4→fa, bc#1→cd, bc#3→ab, cd#1→da, cd#3→bc, cd#5→de, da#1→ab, da#3→cd, da#4→de, da#6→fa, de#1→ef, de#3→da, de#4→cd, ef#1→fa, ef#3→de, fa#3→ef, fa#5→ab, fa#6→da
S4 A2 rebuild: 0 foreign pieces, 0 leaking faces
S4 A1 rebuild: 13 joint faces: ab#1→bc, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, da#1→ab, da#3→de+cd, de#1→ef, de#3→cd, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef
S4 A1 rebuild: 2 foreign pieces, 1 leaking faces
S4 A1 rebuild ab#2 → room1 [0.000, 19.651] (not a side role) + room0 [306.759, 7625.000]
S4 A1 rebuild ab#3 → room1 [140.000, 200.000] (not a side role)
S4 A1 rebuild cd#2 → room0 [0.000, 2707.698]
S4 A1 rebuild de#2 → room1 [265.958, 13121.152]
S4 A1 rebuild leak ab#2 Room { room: RoomId("room0") } colour on Room { room: RoomId("room1") } strip 19.651 mm
S5 A2 first: 28 joint faces: ab#1→bc, ab#3→da, ab#4→ga, bc#1→cd, bc#3→ab, cd#1→da, cd#3→bc, cd#5→de, da#1→ab, da#3→cd, da#4→de, da#6→ea, de#1→ea, de#3→da, de#4→cd, de#6→ef, ea#1→da, ea#3→de, ea#4→ef, ea#6→ga, ef#1→fg, ef#3→ea, ef#4→de, fg#1→ga, fg#3→ef, ga#1→ea, ga#3→fg, ga#5→ab
S5 A2 first: 0 foreign pieces, 0 leaking faces
S5 A2 rebuild: 28 joint faces: ab#1→bc, ab#3→da, ab#4→ga, bc#1→cd, bc#3→ab, cd#1→da, cd#3→bc, cd#5→de, da#1→ab, da#3→cd, da#4→de, da#6→ea, de#1→ea, de#3→da, de#4→cd, de#6→ef, ea#1→da, ea#3→de, ea#4→ef, ea#6→ga, ef#1→fg, ef#3→ea, ef#4→de, fg#1→ga, fg#3→ef, ga#1→ea, ga#3→fg, ga#5→ab
S5 A2 rebuild: 0 foreign pieces, 0 leaking faces
G A2 first: 28 joint faces: ab#1→bc, ab#3→da, ab#4→ga, bc#1→cd, bc#3→ab, cd#1→da, cd#3→bc, cd#5→de, da#1→ab, da#3→cd, da#4→de, da#7→ea, de#1→ea, de#3→da, de#4→cd, de#6→ef, ea#3→de, ea#4→ef, ea#6→ga, ea#7→da, ef#1→fg, ef#3→ea, ef#4→de, fg#1→ga, fg#3→ef, ga#1→ea, ga#3→fg, ga#5→ab
G A2 first: 0 foreign pieces, 0 leaking faces
G A1 first: 18 joint faces: ab#1→bc, ab#3→ga, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, da#1→ab, da#3→de+cd, de#1→ef, de#3→cd, ea#1→ga, ea#3→ef+de, ef#1→fg, ef#3→de, fg#1→ga, fg#3→ef, ga#1→ab, ga#3→fg
G A1 first: 2 foreign pieces, 2 leaking faces
G A1 first ab#2 → room1 [0.000, 23.205] (not a side role) + room0 [323.205, 7925.000]
G A1 first cd#2 → room0 [0.000, 2708.751]
G A1 first de#2 → room1 [279.904, 10112.401]
G A1 first ef#2 → room2 [20.096, 2728.848]
G A1 first ga#2 → room2 [0.000, 7601.795] + room1 [7901.795, 7925.000] (not a side role)
G A1 first leak ab#2 Room { room: RoomId("room0") } colour on Room { room: RoomId("room1") } strip 23.205 mm
G A1 first leak ga#2 Room { room: RoomId("room2") } colour on Room { room: RoomId("room1") } strip 23.205 mm
G A2 rebuild: 28 joint faces: ab#1→bc, ab#3→da, ab#4→ga, bc#1→cd, bc#3→ab, cd#1→da, cd#3→bc, cd#5→de, da#1→ab, da#3→cd, da#4→de, da#7→ea, de#1→ea, de#3→da, de#4→cd, de#6→ef, ea#3→de, ea#4→ef, ea#6→ga, ea#7→da, ef#1→fg, ef#3→ea, ef#4→de, fg#1→ga, fg#3→ef, ga#1→ea, ga#3→fg, ga#5→ab
G A2 rebuild: 0 foreign pieces, 0 leaking faces
G A1 rebuild: 18 joint faces: ab#1→bc, ab#3→ga, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, da#1→ab, da#3→de+cd, de#1→ef, de#3→cd, ea#1→ga, ea#3→ef+de, ef#1→fg, ef#3→de, fg#1→ga, fg#3→ef, ga#1→ab, ga#3→fg
G A1 rebuild: 2 foreign pieces, 2 leaking faces
G A1 rebuild ab#2 → room1 [0.000, 19.651] (not a side role) + room0 [306.759, 7625.000]
G A1 rebuild cd#2 → room0 [0.000, 2707.698]
G A1 rebuild de#2 → room1 [265.958, 10098.361]
G A1 rebuild ef#2 → room2 [19.136, 2728.848]
G A1 rebuild ga#2 → room2 [0.000, 7885.255] + room1 [8198.335, 8225.000] (not a side role)
G A1 rebuild leak ab#2 Room { room: RoomId("room0") } colour on Room { room: RoomId("room1") } strip 19.651 mm
G A1 rebuild leak ga#2 Room { room: RoomId("room2") } colour on Room { room: RoomId("room1") } strip 26.665 mm
F1 A2 first: 28 joint faces: ab#1→bc, ab#3→da, ab#4→ga, bc#1→cd, bc#3→ab, cd#1→da, cd#3→bc, cd#5→de, da#1→ab, da#3→cd, da#4→de, da#6→ea, de#1→ea, de#3→da, de#4→cd, de#6→ef, ea#1→da, ea#3→de, ea#4→ef, ea#6→ga, ef#1→fg, ef#3→ea, ef#4→de, fg#1→ga, fg#3→ef, ga#1→ea, ga#3→fg, ga#5→ab
F1 A2 first: 0 foreign pieces, 0 leaking faces
F1 B first: 33 splits, 34 fragments
F1 B first: 28 joint faces: ab#3→bc, ab#5→ga, ab#6→da, bc#1→ab, bc#4→cd, cd#4→bc, cd#5→de, cd#6→da, da#2→ea, da#3→ab, da#6→cd, da#7→de, de#3→da, de#5→cd, de#6→ea, de#7→ef, ea#4→de, ea#5→da, ea#6→ga, ea#7→ef, ef#2→de, ef#3→ea, ef#5→fg, fg#1→ef, fg#4→ga, ga#0→ab, ga#1→ea, ga#6→fg
F1 B first: 0 foreign pieces, 0 leaking faces
F1 A2 rebuild: 28 joint faces: ab#1→bc, ab#3→da, ab#4→ga, bc#1→cd, bc#3→ab, cd#1→da, cd#3→bc, cd#5→de, da#1→ab, da#3→cd, da#4→de, da#6→ea, de#1→ea, de#3→da, de#4→cd, de#6→ef, ea#1→da, ea#3→de, ea#4→ef, ea#6→ga, ef#1→fg, ef#3→ea, ef#4→de, fg#1→ga, fg#3→ef, ga#1→ea, ga#3→fg, ga#5→ab
F1 A2 rebuild: 0 foreign pieces, 0 leaking faces
F1 B rebuild: 35 splits, 36 fragments
F1 B rebuild: 28 joint faces: ab#2→bc, ab#4→ga, ab#6→da, bc#1→ab, bc#4→cd, cd#4→bc, cd#5→de, cd#6→da, da#2→ab, da#4→cd, da#5→ea, da#7→de, de#2→ef, de#5→da, de#6→cd, de#7→ea, ea#4→de, ea#5→da, ea#6→ga, ea#7→ef, ef#2→de, ef#3→ea, ef#5→fg, fg#1→ef, fg#4→ga, ga#4→fg, ga#5→ab, ga#6→ea
F1 B rebuild: 0 foreign pieces, 0 leaking faces
F2 A2 first: 28 joint faces: ab#1→bc, ab#3→da, ab#4→ga, bc#1→cd, bc#3→ab, cd#1→da, cd#3→bc, cd#5→de, da#1→ab, da#3→cd, da#4→de, da#6→ea, de#1→ea, de#3→da, de#4→cd, de#6→ef, ea#1→da, ea#3→de, ea#4→ef, ea#6→ga, ef#1→fg, ef#3→ea, ef#4→de, fg#1→ga, fg#3→ef, ga#1→ea, ga#3→fg, ga#5→ab
F2 A2 first: 0 foreign pieces, 0 leaking faces
F2 B first: 36 splits, 37 fragments
F2 B first: 28 joint faces: ab#2→ga, ab#5→bc, ab#6→da, bc#2→ab, bc#5→cd, cd#3→de, cd#4→da, cd#6→bc, da#1→cd, da#2→de, da#6→ea, da#7→ab, de#1→cd, de#2→da, de#5→ef, de#6→ea, ea#2→da, ea#3→ga, ea#6→de, ea#7→ef, ef#3→ea, ef#4→de, ef#5→fg, fg#1→ef, fg#3→ga, ga#4→fg, ga#5→ab, ga#6→ea
F2 B first: 0 foreign pieces, 0 leaking faces
F2 A2 rebuild: 28 joint faces: ab#1→bc, ab#3→da, ab#4→ga, bc#1→cd, bc#3→ab, cd#1→da, cd#3→bc, cd#5→de, da#1→ab, da#3→cd, da#4→de, da#6→ea, de#1→ea, de#3→da, de#4→cd, de#6→ef, ea#1→da, ea#3→de, ea#4→ef, ea#6→ga, ef#1→fg, ef#3→ea, ef#4→de, fg#1→ga, fg#3→ef, ga#1→ea, ga#3→fg, ga#5→ab
F2 A2 rebuild: 0 foreign pieces, 0 leaking faces
F2 B rebuild: 36 splits, 37 fragments
F2 B rebuild: 28 joint faces: ab#2→ga, ab#5→bc, ab#6→da, bc#2→ab, bc#5→cd, cd#3→de, cd#4→da, cd#6→bc, da#1→cd, da#2→de, da#6→ea, da#7→ab, de#1→cd, de#2→da, de#5→ef, de#6→ea, ea#2→da, ea#3→ga, ea#6→de, ea#7→ef, ef#3→ea, ef#4→de, ef#5→fg, fg#1→ef, fg#3→ga, ga#4→fg, ga#5→ab, ga#6→ea
F2 B rebuild: 0 foreign pieces, 0 leaking faces
F3 A2 first: 36 joint faces: ab#1→bc, ab#3→da, ab#4→ha, bc#1→cd, bc#3→ab, cd#1→da, cd#3→bc, cd#5→de, da#1→ab, da#3→cd, da#4→de, da#6→ea, de#1→ea, de#3→da, de#4→cd, de#6→ef, ea#1→da, ea#3→de, ea#4→ef, ea#6→fa, ef#1→fa, ef#3→ea, ef#4→de, ef#6→fg, fa#1→ea, fa#3→ef, fa#4→fg, fa#6→ha, fg#1→gh, fg#3→fa, fg#4→ef, gh#1→ha, gh#3→fg, ha#1→fa, ha#3→gh, ha#5→ab
F3 A2 first: 0 foreign pieces, 0 leaking faces
F3 B first: 49 splits, 50 fragments
F3 B first: 36 joint faces: ab#2→bc, ab#5→ha, ab#6→da, bc#1→ab, bc#4→cd, cd#4→bc, cd#5→de, cd#6→da, da#0→cd, da#1→de, da#5→ea, da#6→ab, de#3→cd, de#5→da, de#6→ea, de#7→ef, ea#3→de, ea#4→da, ea#5→fa, ea#6→ef, ef#1→de, ef#5→ea, ef#6→fa, ef#7→fg, fa#4→ef, fa#5→ea, fa#6→ha, fa#7→fg, fg#2→ef, fg#3→fa, fg#5→gh, gh#1→fg, gh#3→ha, ha#1→ab, ha#2→fa, ha#6→gh
F3 B first: 0 foreign pieces, 0 leaking faces
F3 A2 rebuild: 36 joint faces: ab#1→bc, ab#3→da, ab#4→ha, bc#1→cd, bc#3→ab, cd#1→da, cd#3→bc, cd#5→de, da#1→ab, da#3→cd, da#4→de, da#6→ea, de#1→ea, de#3→da, de#4→cd, de#6→ef, ea#1→da, ea#3→de, ea#4→ef, ea#6→fa, ef#1→fa, ef#3→ea, ef#4→de, ef#6→fg, fa#1→ea, fa#3→ef, fa#4→fg, fa#6→ha, fg#1→gh, fg#3→fa, fg#4→ef, gh#1→ha, gh#3→fg, ha#1→fa, ha#3→gh, ha#5→ab
F3 A2 rebuild: 0 foreign pieces, 0 leaking faces
F3 B rebuild: 51 splits, 52 fragments
F3 B rebuild: 36 joint faces: ab#3→bc, ab#5→ha, ab#6→da, bc#1→ab, bc#4→cd, cd#4→bc, cd#5→de, cd#6→da, da#0→cd, da#1→de, da#5→ea, da#6→ab, de#2→cd, de#3→da, de#6→ef, de#7→ea, ea#2→da, ea#3→fa, ea#6→de, ea#7→ef, ef#2→de, ef#3→ea, ef#4→fa, ef#7→fg, fa#4→ef, fa#5→ea, fa#6→ha, fa#7→fg, fg#2→ef, fg#3→fa, fg#5→gh, gh#1→fg, gh#3→ha, ha#2→ab, ha#3→fa, ha#6→gh
F3 B rebuild: 0 foreign pieces, 0 leaking faces
E A2 first: 28 joint faces: ab#1→bc, ab#3→da, ab#4→ga, bc#1→cd, bc#3→ab, cd#1→da, cd#3→bc, cd#5→de, da#1→ab, da#3→cd, da#4→de, da#6→ea, de#1→ea, de#3→da, de#4→cd, de#6→ef, ea#1→da, ea#3→de, ea#4→ef, ea#6→ga, ef#1→fg, ef#3→ea, ef#4→de, fg#1→ga, fg#3→ef, ga#1→ea, ga#3→fg, ga#5→ab
E A2 first: 0 foreign pieces, 0 leaking faces
E A2 rebuild: 28 joint faces: ab#1→bc, ab#3→da, ab#4→ga, bc#1→cd, bc#3→ab, cd#1→da, cd#3→bc, cd#5→de, da#1→ab, da#3→cd, da#4→de, da#6→ea, de#1→ea, de#3→da, de#4→cd, de#6→ef, ea#1→da, ea#3→de, ea#4→ef, ea#6→ga, ef#1→fg, ef#3→ea, ef#4→de, fg#1→ga, fg#3→ef, ga#1→ea, ga#3→fg, ga#5→ab
E A2 rebuild: 0 foreign pieces, 0 leaking faces
Y1 A2 first: 24 joint faces: ab#1→bc, ab#3→ca, ab#4→da, ab#6→db, bc#1→ca, bc#3→ab, bc#4→db, bc#6→cd, ca#1→ab, ca#3→bc, ca#4→cd, ca#6→da, cd#1→da, cd#3→ca, cd#4→bc, cd#6→db, da#1→ca, da#3→cd, da#4→db, da#6→ab, db#1→ab, db#3→da, db#4→cd, db#6→bc
Y1 A2 first: 0 foreign pieces, 0 leaking faces
Y1 B first: 35 splits, 36 fragments
Y1 B first: 24 joint faces: ab#1→db, ab#2→ca, ab#3→bc, ab#4→da, bc#1→ab, bc#3→db, bc#6→cd, bc#7→ca, ca#1→ab, ca#3→cd, ca#4→da, ca#5→bc, cd#1→ca, cd#2→bc, cd#6→db, cd#7→da, da#3→cd, da#4→ca, da#5→ab, da#6→db, db#2→bc, db#3→ab, db#5→da, db#7→cd
Y1 B first: 0 foreign pieces, 0 leaking faces
Y1 A2 rebuild: 24 joint faces: ab#1→bc, ab#3→ca, ab#4→da, ab#6→db, bc#1→ca, bc#3→ab, bc#4→db, bc#6→cd, ca#1→ab, ca#3→bc, ca#4→cd, ca#6→da, cd#1→da, cd#3→ca, cd#4→bc, cd#6→db, da#0→ab, da#3→db, da#4→cd, da#7→ca, db#1→ab, db#3→da, db#4→cd, db#6→bc
Y1 A2 rebuild: 0 foreign pieces, 0 leaking faces
Y1 B rebuild: 51 splits, 52 fragments
Y1 B rebuild: 24 joint faces: ab#0→db, ab#1→da, ab#3→ca, ab#4→bc, bc#2→ab, bc#5→db, bc#6→cd, bc#7→ca, ca#0→ab, ca#1→da, ca#3→cd, ca#4→bc, cd#3→ca, cd#4→bc, cd#5→da, cd#7→db, da#3→cd, da#4→ca, da#6→ab, da#7→db, db#0→bc, db#1→ab, db#5→da, db#7→cd
Y1 B rebuild: 0 foreign pieces, 0 leaking faces
Y2 A2 first: 24 joint faces: ab#4→da, ab#5→ca, ab#6→db, ab#7→bc, bc#1→ca, bc#3→ab, bc#4→db, bc#6→cd, ca#1→ab, ca#3→bc, ca#4→cd, ca#6→da, cd#1→da, cd#3→ca, cd#4→bc, cd#6→db, da#1→ca, da#3→cd, da#4→db, da#6→ab, db#1→ab, db#3→da, db#4→cd, db#6→bc
Y2 A2 first: 0 foreign pieces, 0 leaking faces
Y2 A2 rebuild: 24 joint faces: ab#1→bc, ab#3→ca, ab#4→da, ab#6→db, bc#1→ca, bc#3→ab, bc#4→db, bc#6→cd, ca#1→ab, ca#3→bc, ca#4→cd, ca#6→da, cd#1→da, cd#3→ca, cd#4→bc, cd#6→db, da#1→ca, da#3→cd, da#4→db, da#6→ab, db#1→ab, db#3→da, db#4→cd, db#6→bc
Y2 A2 rebuild: 0 foreign pieces, 0 leaking faces
YN A2 first: 24 joint faces: ab#1→bc, ab#3→ca, ab#4→da, ab#6→db, bc#1→ca, bc#3→ab, bc#4→db, bc#6→cd, ca#1→ab, ca#3→bc, ca#4→cd, ca#6→da, cd#1→da, cd#3→ca, cd#4→bc, cd#6→db, da#1→ca, da#3→cd, da#4→db, da#6→ab, db#1→ab, db#3→da, db#4→cd, db#6→bc
YN A2 first: 0 foreign pieces, 0 leaking faces
YN A2 rebuild: 24 joint faces: ab#1→bc, ab#3→ca, ab#4→da, ab#6→db, bc#1→ca, bc#3→ab, bc#4→db, bc#6→cd, ca#1→ab, ca#3→bc, ca#4→cd, ca#6→da, cd#1→da, cd#3→ca, cd#4→bc, cd#6→db, da#1→ca, da#3→cd, da#4→db, da#6→ab, db#1→ab, db#3→da, db#4→cd, db#6→bc
YN A2 rebuild: 0 foreign pieces, 0 leaking faces
Q A2 first: 32 joint faces: ab#1→bc, ab#3→ca, ab#4→ea, ab#6→eb, bc#1→ca, bc#3→ab, bc#4→eb, bc#6→cd, ca#1→ab, ca#3→bc, ca#4→cd, ca#6→da, cd#1→da, cd#3→ca, cd#4→bc, cd#6→de, da#1→ca, da#3→cd, da#4→de, da#6→ea, de#1→ea, de#3→da, de#4→cd, de#6→eb, ea#1→da, ea#3→de, ea#4→eb, ea#6→ab, eb#1→ab, eb#3→ea, eb#4→de, eb#6→bc
Q A2 first: 0 foreign pieces, 0 leaking faces
Q B first: 53 splits, 54 fragments
Q B first: 32 joint faces: ab#3→ea, ab#4→ca, ab#5→eb, ab#6→bc, bc#2→ab, bc#3→eb, bc#6→cd, bc#7→ca, ca#0→ab, ca#3→da, ca#5→bc, ca#7→cd, cd#4→ca, cd#5→bc, cd#6→de, cd#7→da, da#0→de, da#2→cd, da#5→ea, da#6→ca, de#1→da, de#2→ea, de#5→eb, de#7→cd, ea#1→ab, ea#5→da, ea#6→eb, ea#7→de, eb#1→bc, eb#2→ab, eb#3→ea, eb#7→de
Q B first: 0 foreign pieces, 0 leaking faces
Q A2 rebuild: 32 joint faces: ab#1→bc, ab#3→ca, ab#4→ea, ab#6→eb, bc#1→ca, bc#3→ab, bc#4→eb, bc#6→cd, ca#1→ab, ca#3→bc, ca#4→cd, ca#6→da, cd#1→da, cd#3→ca, cd#4→bc, cd#6→de, da#1→ca, da#3→cd, da#4→de, da#6→ea, de#1→ea, de#3→da, de#4→cd, de#6→eb, ea#1→da, ea#3→de, ea#4→eb, ea#6→ab, eb#1→ab, eb#3→ea, eb#4→de, eb#6→bc
Q A2 rebuild: 0 foreign pieces, 0 leaking faces
Q B rebuild: 52 splits, 53 fragments
Q B rebuild: 32 joint faces: ab#3→ea, ab#4→ca, ab#5→eb, ab#6→bc, bc#3→ab, bc#5→eb, bc#6→cd, bc#7→ca, ca#0→ab, ca#3→da, ca#5→bc, ca#7→cd, cd#3→ca, cd#4→bc, cd#5→de, cd#7→da, da#0→de, da#2→cd, da#5→ea, da#6→ca, de#1→da, de#2→ea, de#5→eb, de#7→cd, ea#1→ab, ea#5→da, ea#6→eb, ea#7→de, eb#1→bc, eb#2→ab, eb#3→ea, eb#7→de
Q B rebuild: 0 foreign pieces, 0 leaking faces
Z A2 first: 14 joint faces: da#1→ab, da#3→bd, ab#1→bd, ab#3→da, ab#5→bc, bd#1→da, bd#3→ab, bd#4→bc, bd#6→cd, bc#1→cd, bc#3→bd, bc#4→ab, cd#1→bd, cd#3→bc
Z A2 first: 0 foreign pieces, 0 leaking faces
Z A2 rebuild: 14 joint faces: da#1→ab, da#3→bd, ab#1→bd, ab#3→da, ab#5→bc, bd#1→da, bd#3→ab, bd#4→bc, bd#6→cd, bc#1→cd, bc#3→bd, bc#4→ab, cd#1→bd, cd#3→bc
Z A2 rebuild: 0 foreign pieces, 0 leaking faces
```
