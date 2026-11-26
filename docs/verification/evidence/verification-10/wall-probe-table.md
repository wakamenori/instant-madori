# 検証10の試作の表

`678a183a9` で `mise exec -- cargo test --release -p madori-modeling wall_probe_table -- --ignored --nocapture` を実行した出力のうち、表と詳細の行である。ms は一回だけの測定で、A1 は `Model::build` 全体、A2 と B は CAD のコマンドだけの時間である。作れない行は、理由をそのまま載せた。

| case | method | build | walls/bodies | overlap (tol) mm³ | excess/deficit (tol) mm³ | Σvol − vol(R) mm³ | A2 vs A1 | B vs A2 | roles | unexplained | joint faces | colours | opening ∩ neighbour mm³ | commands | ms | B fragments |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| P30 | A2 | first | 7/7 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | — | — | 14/14 | 0 | 14 | 3 | 0.00 | 31 | 15.58 | 0 |
| P30 | A1 | first | 7/7 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | pass | — | 14/14 | 0 | 14 | 3 | 0.00 | — | 20.91 | 0 |
| P30 | B | first | 7/7 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | — | pass | 14/14 | 0 | 14 | 3 | 0.00 | 44 | 309.12 | 25 |
| P30 | A2 | rebuild | 7/7 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | — | — | 14/14 | 0 | 14 | 3 | 0.00 | 31 | 6.85 | 0 |
| P30 | A1 | rebuild | 7/7 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | pass | — | 14/14 | 0 | 14 | 3 | 0.00 | — | 9.72 | 0 |
| P30 | B | rebuild | 7/7 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | pass | 14/14 | 0 | 14 | 3 | 0.00 | 44 | 273.07 | 25 |
| P45 | A2 | first | 7/7 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | — | — | 14/14 | 0 | 14 | 3 | 0.00 | 31 | 14.24 | 0 |
| P45 | A1 | first | 7/7 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | pass | — | 14/14 | 0 | 14 | 3 | 0.00 | — | 18.35 | 0 |
| P45 | B | first | 7/7 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | — | pass | 14/14 | 0 | 14 | 3 | 0.00 | 46 | 286.96 | 27 |
| P45 | A2 | rebuild | 7/7 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | — | — | 14/14 | 0 | 14 | 3 | 0.00 | 31 | 6.49 | 0 |
| P45 | A1 | rebuild | 7/7 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | pass | — | 14/14 | 0 | 14 | 3 | 0.00 | — | 9.19 | 0 |
| P45 | B | rebuild | 7/7 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | — | pass | 14/14 | 0 | 14 | 3 | 0.00 | 46 | 280.69 | 27 |
| P60 | A2 | first | 7/7 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | — | 14/14 | 0 | 14 | 3 | 0.00 | 31 | 17.39 | 0 |
| P60 | A1 | first | 7/7 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | pass | — | 14/14 | 0 | 14 | 3 | 0.00 | — | 19.91 | 0 |
| P60 | B | first | 7/7 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | pass | 14/14 | 0 | 14 | 3 | 0.00 | 38 | 203.53 | 19 |
| P60 | A2 | rebuild | 7/7 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | — | 14/14 | 0 | 14 | 3 | 0.00 | 31 | 6.72 | 0 |
| P60 | A1 | rebuild | 7/7 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | pass | — | 14/14 | 0 | 14 | 3 | 0.00 | — | 9.04 | 0 |
| P60 | B | rebuild | 7/7 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | pass | 14/14 | 0 | 14 | 3 | 0.00 | 38 | 198.79 | 19 |
| W | A2 | first | 7/7 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | — | 14/14 | 0 | 14 | 3 | 0.00 | 35 | 17.68 | 0 |
| W | A1 | first | 7/7 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | pass | — | 14/14 | 0 | 14 | 3 | 0.00 | — | 23.80 | 0 |
| W | B | first | 7/7 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | pass | 14/14 | 0 | 14 | 3 | 0.00 | 42 | 198.01 | 19 |
| W | A2 | rebuild | 7/7 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | — | 14/14 | 0 | 14 | 3 | 0.00 | 35 | 11.42 | 0 |
| W | A1 | rebuild | 7/7 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | pass | — | 14/14 | 0 | 14 | 3 | 0.00 | — | 15.13 | 0 |
| W | B | rebuild | 7/7 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | pass | 14/14 | 0 | 14 | 3 | 0.00 | 42 | 194.52 | 19 |
| A20 | A2 | first | 7/7 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | — | 14/14 | 0 | 14 | 3 | 0.00 | 31 | 24.67 | 0 |
| A20 | A1 | first | 7/7 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | pass | — | 14/14 | 0 | 14 | 3 | 0.00 | — | 19.37 | 0 |
| A20 | B | first | 7/7 | 0.00 (360) | 0.00/148507337.19 (360) | -148507337.19 | — | bevel (see below) | 14/14 | 4 | 14 | 3 | 0.00 | 40 | 303.92 | 25 |
| A20 | A2 | rebuild | 7/7 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | — | 14/14 | 0 | 14 | 3 | 0.00 | 31 | 6.70 | 0 |
| A20 | A1 | rebuild | 7/7 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | pass | — | 14/14 | 0 | 14 | 3 | 0.00 | — | 10.83 | 0 |
| A20 | B | rebuild | 7/7 | 0.00 (360) | 0.00/145815054.52 (360) | -145815054.52 | — | bevel (see below) | 14/14 | 4 | 14 | 3 | 0.00 | 40 | 307.44 | 25 |
| X | A2 | first | 12/12 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | — | — | 24/24 | 0 | 24 | 3 | 0.00 | 51 | 23.33 | 0 |
| X | A1 | first | 12/12 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | pass | — | 24/24 | 0 | 24 | 3 | 0.00 | — | 29.47 | 0 |
| X | B | first | 12/12 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | — | pass | 24/24 | 0 | 24 | 3 | 0.00 | 79 | 517.51 | 50 |
| X | A2 | rebuild | 12/12 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | — | — | 24/24 | 0 | 24 | 3 | 0.00 | 51 | 7.27 | 0 |
| X | A1 | rebuild | 12/12 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | pass | — | 24/24 | 0 | 24 | 3 | 0.00 | — | 12.55 | 0 |
| X | B | rebuild | 12/12 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | — | pass | 24/24 | 0 | 24 | 3 | 0.00 | 79 | 476.76 | 50 |
| S1 | A2 | first | 7/7 | 0.00 (336) | 0.00/0.00 (336) | -0.00 | — | — | 14/14 | 0 | 16 | 3 | 0.00 | 31 | 14.82 | 0 |
| S1 | A1 | first | 7/7 | 0.00 (336) | 0.00/0.00 (336) | -0.00 | pass | — | 14/14 | 0 | 16 | 3 | 0.00 | — | 18.45 | 0 |
| S1 | B | first | NotExpressible: thin extrusion requires uniform centred thickness |
| S1 | A2 | rebuild | 7/7 | 0.00 (336) | 0.00/0.00 (336) | -0.00 | — | — | 14/14 | 0 | 16 | 3 | 0.00 | 31 | 6.64 | 0 |
| S1 | A1 | rebuild | 7/7 | 0.00 (336) | 0.00/0.00 (336) | -0.00 | pass | — | 14/14 | 0 | 16 | 3 | 0.00 | — | 9.13 | 0 |
| S1 | B | rebuild | NotExpressible: thin extrusion requires uniform centred thickness |
| S1b | A2 | first | 7/7 | 0.00 (336) | 0.00/0.00 (336) | -0.00 | — | — | 14/14 | 0 | 16 | 3 | 0.00 | 31 | 14.57 | 0 |
| S1b | A1 | first | 7/7 | 0.00 (336) | 0.00/0.00 (336) | -0.00 | pass | — | 14/14 | 0 | 16 | 3 | 0.00 | — | 18.72 | 0 |
| S1b | B | first | NotExpressible: thin extrusion requires uniform centred thickness |
| S1b | A2 | rebuild | 7/7 | 0.00 (336) | 0.00/0.00 (336) | 0.00 | — | — | 14/14 | 0 | 16 | 3 | 0.00 | 31 | 6.72 | 0 |
| S1b | A1 | rebuild | 7/7 | 0.00 (336) | 0.00/0.00 (336) | 0.00 | pass | — | 14/14 | 0 | 16 | 3 | 0.00 | — | 10.22 | 0 |
| S1b | B | rebuild | NotExpressible: thin extrusion requires uniform centred thickness |
| S2 | A2 | first | 9/9 | 0.00 (336) | 0.00/0.00 (336) | -0.00 | — | — | 18/18 | 0 | 20 | 3 | 0.00 | 39 | 18.71 | 0 |
| S2 | A1 | first | Vertex "a": UnresolvedJoint { boundaries: ["da", "ea"] }<br>Vertex "a": UnresolvedJoint { boundaries: ["da", "ea"] } |
| S2 | B | first | NotExpressible: thin extrusion requires uniform centred thickness |
| S2 | A2 | rebuild | 9/9 | 0.00 (336) | 0.00/0.00 (336) | -0.00 | — | — | 18/18 | 0 | 20 | 3 | 0.00 | 39 | 7.07 | 0 |
| S2 | A1 | rebuild | Vertex "a": UnresolvedJoint { boundaries: ["da", "ea"] }<br>Vertex "a": UnresolvedJoint { boundaries: ["da", "ea"] } |
| S2 | B | rebuild | NotExpressible: thin extrusion requires uniform centred thickness |
| F1 | A2 | first | 9/9 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | — | — | 18/18 | 0 | 20 | 3 | 0.00 | 39 | 18.10 | 0 |
| F1 | A1 | first | Vertex "a": UnresolvedJoint { boundaries: ["da", "ea"] }<br>Vertex "a": UnresolvedJoint { boundaries: ["da", "ea"] } |
| F1 | B | first | 9/9 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | pass | 18/18 | 0 | 20 | 3 | 0.00 | 45 | 226.11 | 22 |
| F1 | A2 | rebuild | 9/9 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | — | — | 18/18 | 0 | 20 | 3 | 0.00 | 39 | 6.62 | 0 |
| F1 | A1 | rebuild | Vertex "a": UnresolvedJoint { boundaries: ["da", "ea"] }<br>Vertex "a": UnresolvedJoint { boundaries: ["da", "ea"] } |
| F1 | B | rebuild | 9/9 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | — | pass | 18/18 | 0 | 20 | 3 | 0.00 | 45 | 229.00 | 22 |
| F2 | A2 | first | 9/9 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | — | 18/18 | 0 | 20 | 3 | 0.00 | 39 | 18.57 | 0 |
| F2 | A1 | first | Vertex "a": UnresolvedJoint { boundaries: ["da", "ea"] }<br>Vertex "a": UnresolvedJoint { boundaries: ["da", "ea"] } |
| F2 | B | first | 9/9 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | pass | 18/18 | 0 | 20 | 3 | 0.00 | 50 | 286.94 | 28 |
| F2 | A2 | rebuild | 9/9 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | — | — | 18/18 | 0 | 20 | 3 | 0.00 | 39 | 7.58 | 0 |
| F2 | A1 | rebuild | Vertex "a": UnresolvedJoint { boundaries: ["da", "ea"] }<br>Vertex "a": UnresolvedJoint { boundaries: ["da", "ea"] } |
| F2 | B | rebuild | 9/9 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | pass | 18/18 | 0 | 20 | 3 | 0.00 | 50 | 294.49 | 27 |
| F3 | A2 | first | 11/11 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | — | — | 22/22 | 0 | 26 | 3 | 0.00 | 47 | 22.13 | 0 |
| F3 | A1 | first | Vertex "a": UnresolvedJoint { boundaries: ["da", "ea"] }<br>Vertex "a": UnresolvedJoint { boundaries: ["ea", "fa"] }<br>Vertex "a": UnresolvedJoint { boundaries: ["ea", "fa"] } |
| F3 | B | first | 11/11 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | — | pass | 22/22 | 0 | 26 | 3 | 0.00 | 57 | 325.25 | 30 |
| F3 | A2 | rebuild | 11/11 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | — | — | 22/22 | 0 | 26 | 3 | 0.00 | 47 | 6.87 | 0 |
| F3 | A1 | rebuild | Vertex "a": UnresolvedJoint { boundaries: ["da", "ea"] }<br>Vertex "a": UnresolvedJoint { boundaries: ["ea", "fa"] }<br>Vertex "a": UnresolvedJoint { boundaries: ["ea", "fa"] } |
| F3 | B | rebuild | 11/11 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | pass | 22/22 | 0 | 26 | 3 | 0.00 | 57 | 321.24 | 30 |
| E | A2 | first | 9/9 | 0.00 (240) | 0.00/0.00 (240) | 0.00 | — | — | 18/18 | 0 | 20 | 3 | 0.00 | 39 | 17.97 | 0 |
| E | A1 | first | Vertex "a": UnresolvedJoint { boundaries: ["da", "ea"] }<br>Vertex "a": UnresolvedJoint { boundaries: ["da", "ea"] } |
| E | B | first | NotExpressible: thin extrusion requires uniform centred thickness |
| E | A2 | rebuild | 9/9 | 0.00 (240) | 0.00/0.00 (240) | -0.00 | — | — | 18/18 | 0 | 20 | 3 | 0.00 | 39 | 6.70 | 0 |
| E | A1 | rebuild | Vertex "a": UnresolvedJoint { boundaries: ["da", "ea"] }<br>Vertex "a": UnresolvedJoint { boundaries: ["da", "ea"] } |
| E | B | rebuild | NotExpressible: thin extrusion requires uniform centred thickness |
| Y1 | A2 | first | 6/6 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | — | 12/12 | 0 | 24 | 3 | 0.00 | 27 | 26.89 | 0 |
| Y1 | A1 | first | Vertex "a": UnresolvedJoint { boundaries: ["ab", "ca", "da"] }<br>Vertex "b": UnresolvedJoint { boundaries: ["bc", "ab", "db"] }<br>Vertex "c": UnresolvedJoint { boundaries: ["cd", "ca", "bc"] }<br>Vertex "c": UnresolvedJoint { boundaries: ["cd", "ca", "bc"] }<br>Vertex "d": UnresolvedJoint { boundaries: ["db", "da", "cd"] }<br>Vertex "d": UnresolvedJoint { boundaries: ["db", "da", "cd"] } |
| Y1 | B | first | 6/6 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | pass | 12/12 | 0 | 24 | 3 | 0.00 | 53 | 418.03 | 36 |
| Y1 | A2 | rebuild | 6/6 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | — | 12/12 | 0 | 24 | 3 | 0.00 | 27 | 18.43 | 0 |
| Y1 | A1 | rebuild | Vertex "a": UnresolvedJoint { boundaries: ["ab", "ca", "da"] }<br>Vertex "b": UnresolvedJoint { boundaries: ["bc", "ab", "db"] }<br>Vertex "c": UnresolvedJoint { boundaries: ["cd", "ca", "bc"] }<br>Vertex "c": UnresolvedJoint { boundaries: ["cd", "ca", "bc"] }<br>Vertex "d": UnresolvedJoint { boundaries: ["db", "da", "cd"] }<br>Vertex "d": UnresolvedJoint { boundaries: ["db", "da", "cd"] } |
| Y1 | B | rebuild | 6/6 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | — | pass | 12/12 | 0 | 24 | 3 | 0.00 | 69 | 570.98 | 52 |
| Y2 | A2 | first | 6/6 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | — | 12/12 | 0 | 24 | 3 | 0.00 | 27 | 19.33 | 0 |
| Y2 | A1 | first | Vertex "a": UnresolvedJoint { boundaries: ["ca", "da", "ab"] }<br>Vertex "b": UnresolvedJoint { boundaries: ["bc", "ab", "db"] }<br>Vertex "c": UnresolvedJoint { boundaries: ["cd", "ca", "bc"] }<br>Vertex "c": UnresolvedJoint { boundaries: ["cd", "ca", "bc"] }<br>Vertex "d": UnresolvedJoint { boundaries: ["db", "da", "cd"] }<br>Vertex "d": UnresolvedJoint { boundaries: ["db", "da", "cd"] } |
| Y2 | B | first | NotExpressible: thin extrusion requires uniform centred thickness |
| Y2 | A2 | rebuild | 6/6 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | — | 12/12 | 0 | 24 | 3 | 0.00 | 27 | 19.76 | 0 |
| Y2 | A1 | rebuild | Vertex "a": UnresolvedJoint { boundaries: ["ca", "da", "ab"] }<br>Vertex "b": UnresolvedJoint { boundaries: ["bc", "ab", "db"] }<br>Vertex "c": UnresolvedJoint { boundaries: ["cd", "ca", "bc"] }<br>Vertex "c": UnresolvedJoint { boundaries: ["cd", "ca", "bc"] }<br>Vertex "d": UnresolvedJoint { boundaries: ["db", "da", "cd"] }<br>Vertex "d": UnresolvedJoint { boundaries: ["db", "da", "cd"] } |
| Y2 | B | rebuild | NotExpressible: thin extrusion requires uniform centred thickness |
| YN | A2 | first | 6/6 | 0.00 (240) | 0.00/0.00 (240) | -0.00 | — | — | 12/12 | 0 | 24 | 3 | 0.00 | 27 | 18.14 | 0 |
| YN | A1 | first | Vertex "a": UnresolvedJoint { boundaries: ["ab", "ca", "da"] }<br>Vertex "b": UnresolvedJoint { boundaries: ["bc", "ab", "db"] }<br>Vertex "c": UnresolvedJoint { boundaries: ["cd", "ca", "bc"] }<br>Vertex "c": UnresolvedJoint { boundaries: ["cd", "ca", "bc"] }<br>Vertex "d": UnresolvedJoint { boundaries: ["db", "da", "cd"] }<br>Vertex "d": UnresolvedJoint { boundaries: ["db", "da", "cd"] } |
| YN | B | first | NotExpressible: thin extrusion requires uniform centred thickness |
| YN | A2 | rebuild | 6/6 | 0.00 (240) | 0.00/0.00 (240) | 0.00 | — | — | 12/12 | 0 | 24 | 3 | 0.00 | 27 | 19.31 | 0 |
| YN | A1 | rebuild | Vertex "a": UnresolvedJoint { boundaries: ["ab", "ca", "da"] }<br>Vertex "b": UnresolvedJoint { boundaries: ["bc", "ab", "db"] }<br>Vertex "c": UnresolvedJoint { boundaries: ["cd", "ca", "bc"] }<br>Vertex "c": UnresolvedJoint { boundaries: ["cd", "ca", "bc"] }<br>Vertex "d": UnresolvedJoint { boundaries: ["db", "da", "cd"] }<br>Vertex "d": UnresolvedJoint { boundaries: ["db", "da", "cd"] } |
| YN | B | rebuild | NotExpressible: thin extrusion requires uniform centred thickness |
| Q | A2 | first | 8/8 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | — | — | 16/16 | 0 | 32 | 3 | 0.00 | 35 | 36.99 | 0 |
| Q | A1 | first | Vertex "a": UnresolvedJoint { boundaries: ["ab", "ca", "da", "ea"] }<br>Vertex "b": UnresolvedJoint { boundaries: ["bc", "ab", "eb"] }<br>Vertex "c": UnresolvedJoint { boundaries: ["cd", "ca", "bc"] }<br>Vertex "c": UnresolvedJoint { boundaries: ["cd", "ca", "bc"] }<br>Vertex "d": UnresolvedJoint { boundaries: ["cd", "de", "da"] }<br>Vertex "d": UnresolvedJoint { boundaries: ["cd", "de", "da"] }<br>Vertex "e": UnresolvedJoint { boundaries: ["eb", "ea", "de"] }<br>Vertex "e": UnresolvedJoint { boundaries: ["eb", "ea", "de"] } |
| Q | B | first | 8/8 | 0.00 (360) | 0.00/0.00 (360) | -0.00 | — | pass | 16/16 | 0 | 32 | 3 | 0.00 | 75 | 647.42 | 54 |
| Q | A2 | rebuild | 8/8 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | — | 16/16 | 0 | 32 | 3 | 0.00 | 35 | 24.10 | 0 |
| Q | A1 | rebuild | Vertex "a": UnresolvedJoint { boundaries: ["ab", "ca", "da", "ea"] }<br>Vertex "b": UnresolvedJoint { boundaries: ["bc", "ab", "eb"] }<br>Vertex "c": UnresolvedJoint { boundaries: ["cd", "ca", "bc"] }<br>Vertex "c": UnresolvedJoint { boundaries: ["cd", "ca", "bc"] }<br>Vertex "d": UnresolvedJoint { boundaries: ["cd", "de", "da"] }<br>Vertex "d": UnresolvedJoint { boundaries: ["cd", "de", "da"] }<br>Vertex "e": UnresolvedJoint { boundaries: ["eb", "ea", "de"] }<br>Vertex "e": UnresolvedJoint { boundaries: ["eb", "ea", "de"] } |
| Q | B | rebuild | 8/8 | 0.00 (360) | 0.00/0.00 (360) | 0.00 | — | pass | 16/16 | 0 | 32 | 3 | 0.00 | 74 | 643.64 | 53 |
| Z | A2 | first | 5/5 | 0.00 (288) | 0.00/0.00 (288) | -0.00 | — | — | 11/11 | 0 | 14 | 4 | 0.00 | 24 | 24.12 | 0 |
| Z | A1 | first | Vertex "d": UnresolvedJoint { boundaries: ["da", "bd", "cd"] }<br>Vertex "b": UnresolvedJoint { boundaries: ["bc", "bd", "ab"] }<br>Vertex "b": UnresolvedJoint { boundaries: ["bc", "bd", "ab"] }<br>Vertex "b": UnresolvedJoint { boundaries: ["bc", "bd", "ab"] }<br>Vertex "d": UnresolvedJoint { boundaries: ["da", "bd", "cd"] } |
| Z | B | first | NotExpressible: thin extrusion requires uniform centred thickness |
| Z | A2 | rebuild | 5/5 | 0.00 (288) | 0.00/0.00 (288) | 0.00 | — | — | 11/11 | 0 | 14 | 4 | 0.00 | 24 | 13.15 | 0 |
| Z | A1 | rebuild | Vertex "d": UnresolvedJoint { boundaries: ["da", "bd", "cd"] }<br>Vertex "b": UnresolvedJoint { boundaries: ["bc", "bd", "ab"] }<br>Vertex "b": UnresolvedJoint { boundaries: ["bc", "bd", "ab"] }<br>Vertex "b": UnresolvedJoint { boundaries: ["bc", "bd", "ab"] }<br>Vertex "d": UnresolvedJoint { boundaries: ["da", "bd", "cd"] } |
| Z | B | rebuild | NotExpressible: thin extrusion requires uniform centred thickness |

```text
P30 A2 first: 14 joint faces: ab#1→bc, ab#3→fa, be#1→ef+de, be#3→bc+ab, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, de#1→ef, de#3→cd
P30 A1 first: 14 joint faces: ab#1→bc, ab#3→fa, be#1→ef+de, be#3→bc+ab, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, de#1→ef, de#3→cd
P30 B first: 24 splits, 25 fragments
P30 B first: 14 joint faces: ab#4→fa, ab#5→bc, be#1→bc+ab, be#3→ef+de, ef#4→de, ef#5→fa, fa#4→ab, fa#5→ef, bc#4→ab, bc#5→cd, cd#1→de, cd#3→bc, de#4→cd, de#5→ef
P30 A2 rebuild: 14 joint faces: ab#1→bc, ab#3→fa, be#1→ef+de, be#3→bc+ab, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, de#1→ef, de#3→cd
P30 A1 rebuild: 14 joint faces: ab#1→bc, ab#3→fa, be#1→ef+de, be#3→bc+ab, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, de#1→ef, de#3→cd
P30 B rebuild: 24 splits, 25 fragments
P30 B rebuild: 14 joint faces: ab#4→fa, ab#5→bc, be#1→bc+ab, be#3→ef+de, ef#4→de, ef#5→fa, fa#4→ab, fa#5→ef, bc#4→ab, bc#5→cd, cd#1→de, cd#3→bc, de#4→cd, de#5→ef
P45 A2 first: 14 joint faces: ab#1→bc, ab#3→fa, be#1→ef+de, be#3→bc+ab, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, de#1→ef, de#3→cd
P45 A1 first: 14 joint faces: ab#1→bc, ab#3→fa, be#1→ef+de, be#3→bc+ab, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, de#1→ef, de#3→cd
P45 B first: 26 splits, 27 fragments
P45 B first: 14 joint faces: ab#4→fa, ab#5→bc, be#1→bc+ab, be#3→de+ef, ef#3→de, ef#5→fa, fa#1→ab, fa#3→ef, bc#3→cd, bc#5→ab, cd#2→bc, cd#4→de, de#4→cd, de#5→ef
P45 A2 rebuild: 14 joint faces: ab#1→bc, ab#3→fa, be#1→ef+de, be#3→bc+ab, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, de#1→ef, de#3→cd
P45 A1 rebuild: 14 joint faces: ab#1→bc, ab#3→fa, be#1→ef+de, be#3→bc+ab, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, de#1→ef, de#3→cd
P45 B rebuild: 26 splits, 27 fragments
P45 B rebuild: 14 joint faces: ab#4→fa, ab#5→bc, be#2→ab+bc, be#4→ef+de, ef#4→de, ef#5→fa, fa#1→ab, fa#3→ef, bc#3→cd, bc#5→ab, cd#1→bc, cd#4→de, de#4→cd, de#5→ef
P60 A2 first: 14 joint faces: ab#1→bc, ab#3→fa, be#1→ef+de, be#3→bc+ab, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, de#1→ef, de#3→cd
P60 A1 first: 14 joint faces: ab#1→bc, ab#3→fa, be#1→ef+de, be#3→bc+ab, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, de#1→ef, de#3→cd
P60 B first: 18 splits, 19 fragments
P60 B first: 14 joint faces: ab#4→fa, ab#5→bc, be#1→bc+ab, be#5→ef+de, ef#4→de, ef#5→fa, fa#1→ab, fa#3→ef, bc#4→ab, bc#5→cd, cd#2→bc, cd#5→de, de#4→cd, de#5→ef
P60 A2 rebuild: 14 joint faces: ab#1→bc, ab#3→fa, be#1→ef+de, be#3→bc+ab, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, de#1→ef, de#3→cd
P60 A1 rebuild: 14 joint faces: ab#1→bc, ab#3→fa, be#1→ef+de, be#3→bc+ab, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, de#1→ef, de#3→cd
P60 B rebuild: 18 splits, 19 fragments
P60 B rebuild: 14 joint faces: ab#4→fa, ab#5→bc, be#1→bc+ab, be#5→ef+de, ef#4→de, ef#5→fa, fa#1→ab, fa#3→ef, bc#4→ab, bc#5→cd, cd#2→bc, cd#5→de, de#4→cd, de#5→ef
W A2 first: 14 joint faces: ab#1→bc, ab#3→fa, be#1→ef+de, be#3→bc+ab, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, de#1→ef, de#3→cd
W A1 first: 14 joint faces: ab#1→bc, ab#3→fa, be#1→ef+de, be#3→bc+ab, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, de#1→ef, de#3→cd
W B first: 18 splits, 19 fragments
W B first: 14 joint faces: ab#4→fa, ab#5→bc, be#1→bc+ab, be#5→ef+de, ef#4→de, ef#5→fa, fa#1→ab, fa#3→ef, bc#4→ab, bc#5→cd, cd#2→bc, cd#5→de, de#4→cd, de#5→ef
W A2 rebuild: 14 joint faces: ab#1→bc, ab#3→fa, be#1→ef+de, be#3→bc+ab, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, de#1→ef, de#3→cd
W A1 rebuild: 14 joint faces: ab#1→bc, ab#3→fa, be#1→ef+de, be#3→bc+ab, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, de#1→ef, de#3→cd
W B rebuild: 18 splits, 19 fragments
W B rebuild: 14 joint faces: ab#4→fa, ab#5→bc, be#1→bc+ab, be#5→ef+de, ef#4→de, ef#5→fa, fa#1→ab, fa#3→ef, bc#4→ab, bc#5→cd, cd#2→bc, cd#5→de, de#4→cd, de#5→ef
A20 A2 first: 14 joint faces: ab#1→bc, ab#3→fa, be#2→bc+ab, be#5→ef+de, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, de#1→ef, de#3→cd
A20 A1 first: 14 joint faces: ab#1→bc, ab#3→fa, be#2→bc+ab, be#5→ef+de, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, de#1→ef, de#3→cd
A20 B first: mitre deficit 148507337.19 mm³, uncovered 418.884173 mm; bevel excess / deficit 0 / 0 mm³.
A20 B first: 24 splits, 25 fragments
A20 B first: 14 joint faces: ab#4→bc, ab#6→fa, be#1→bc+ab, be#4→ef+de, ef#4→de, ef#5→fa, fa#3→ef, fa#6→ab, bc#4→ab, bc#5→cd, cd#2→bc, cd#6→de, de#5→cd, de#6→ef
A20 A2 rebuild: 14 joint faces: ab#1→bc, ab#3→fa, be#2→bc+ab, be#5→ef+de, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, de#1→ef, de#3→cd
A20 A1 rebuild: 14 joint faces: ab#1→bc, ab#3→fa, be#2→bc+ab, be#5→ef+de, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, de#1→ef, de#3→cd
A20 B rebuild: mitre deficit 145815054.52 mm³, uncovered 418.884173 mm; bevel excess / deficit 0 / 0 mm³.
A20 B rebuild: 24 splits, 25 fragments
A20 B rebuild: 14 joint faces: ab#4→bc, ab#6→fa, be#0→ab+bc, be#3→ef+de, ef#4→de, ef#5→fa, fa#3→ef, fa#6→ab, bc#4→ab, bc#5→cd, cd#2→bc, cd#6→de, de#5→cd, de#6→ef
X A2 first: 24 joint faces: ab#1→bc+ib, ab#3→fa, bc#1→cd, bc#3→ib, cd#1→de, cd#3→bc, da#1→ab+fa, da#3→de+cd, de#1→ef, de#3→cd, ef#1→fg, ef#3→de, fa#1→ab, fa#3→fg+ef, fg#1→gh, fg#3→ef, gh#1→hi, gh#3→fg, ha#1→fa+ab, ha#3→hi+gh, hi#1→ib, hi#3→gh, ib#1→bc, ib#3→hi
X A1 first: 24 joint faces: ab#1→bc+ib, ab#3→fa, bc#1→cd, bc#3→ib, cd#1→de, cd#3→bc, da#1→ab+fa, da#3→de+cd, de#1→ef, de#3→cd, ef#1→fg, ef#3→de, fa#1→ab, fa#3→fg+ef, fg#1→gh, fg#3→ef, gh#1→hi, gh#3→fg, ha#1→fa+ab, ha#3→hi+gh, hi#1→ib, hi#3→gh, ib#1→bc, ib#3→hi
X B first: 49 splits, 50 fragments
X B first: 24 joint faces: ab#1→fa, ab#4→ib+bc, bc#4→ib, bc#5→cd, cd#2→bc, cd#5→de, da#2→cd+de, da#4→fa+ab, de#0→cd, de#5→ef, ef#3→de, ef#4→fg, fa#2→ab, fa#4→ef+fg, fg#3→ef, fg#5→gh, gh#2→fg, gh#5→hi, ha#1→gh+hi, ha#5→ab+fa, hi#4→gh, hi#5→ib, ib#4→bc, ib#5→hi
X A2 rebuild: 24 joint faces: ab#1→bc+ib, ab#3→fa, bc#1→cd, bc#3→ib, cd#1→de, cd#3→bc, da#1→ab+fa, da#3→de+cd, de#1→ef, de#3→cd, ef#1→fg, ef#3→de, fa#1→ab, fa#3→fg+ef, fg#1→gh, fg#3→ef, gh#1→hi, gh#3→fg, ha#2→hi+gh, ha#5→fa+ab, hi#1→ib, hi#3→gh, ib#1→bc, ib#3→hi
X A1 rebuild: 24 joint faces: ab#1→bc+ib, ab#3→fa, bc#1→cd, bc#3→ib, cd#1→de, cd#3→bc, da#1→ab+fa, da#3→de+cd, de#1→ef, de#3→cd, ef#1→fg, ef#3→de, fa#1→ab, fa#3→fg+ef, fg#1→gh, fg#3→ef, gh#1→hi, gh#3→fg, ha#2→hi+gh, ha#5→fa+ab, hi#1→ib, hi#3→gh, ib#1→bc, ib#3→hi
X B rebuild: 49 splits, 50 fragments
X B rebuild: 24 joint faces: ab#1→fa, ab#4→ib+bc, bc#4→ib, bc#5→cd, cd#2→bc, cd#5→de, da#2→cd+de, da#4→fa+ab, de#0→cd, de#5→ef, ef#3→de, ef#4→fg, fa#2→ab, fa#4→ef+fg, fg#3→ef, fg#5→gh, gh#2→fg, gh#5→hi, ha#1→gh+hi, ha#5→ab+fa, hi#4→gh, hi#5→ib, ib#4→bc, ib#5→hi
S1 A2 first: 16 joint faces: ab#1→bc, ab#3→fa+da, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, da#1→ab, da#3→de+cd, da#5→fa, da#6→ab, de#1→ef, de#3→cd, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef
S1 A1 first: 16 joint faces: ab#1→bc, ab#3→fa+da, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, da#1→ab, da#3→de+cd, da#5→fa, da#6→ab, de#1→ef, de#3→cd, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef
S1 A2 rebuild: 16 joint faces: ab#1→bc, ab#3→fa+da, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, da#1→ab, da#3→de+cd, da#5→fa, da#6→ab, de#1→ef, de#3→cd, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef
S1 A1 rebuild: 16 joint faces: ab#1→bc, ab#3→fa+da, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, da#1→ab, da#3→de+cd, da#5→fa, da#6→ab, de#1→ef, de#3→cd, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef
S1b A2 first: 16 joint faces: ab#1→bc, ab#3→fa+da, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, da#1→ab, da#3→de+cd, da#5→fa, da#6→ab, de#1→ef, de#3→cd, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef
S1b A1 first: 16 joint faces: ab#1→bc, ab#3→fa+da, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, da#1→ab, da#3→de+cd, da#5→fa, da#6→ab, de#1→ef, de#3→cd, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef
S1b A2 rebuild: 16 joint faces: ab#1→bc, ab#3→fa+da, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, da#1→ab, da#3→de+cd, da#5→fa, da#6→ab, de#1→ef, de#3→cd, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef
S1b A1 rebuild: 16 joint faces: ab#1→bc, ab#3→fa+da, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, da#1→ab, da#3→de+cd, da#5→fa, da#6→ab, de#1→ef, de#3→cd, ef#1→fa, ef#3→de, fa#1→ab, fa#3→ef
S2 A2 first: 20 joint faces: ab#1→bc, ab#3→ga+ea, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, da#1→ab, da#3→de+cd, da#5→ea, de#1→ef, de#3→cd, ea#1→da+ab, ea#3→ef+de, ea#5→ga, ef#1→fg, ef#3→de, fg#1→ga, fg#3→ef, ga#1→ab, ga#3→fg
S2 A2 rebuild: 20 joint faces: ab#1→bc, ab#3→ga+ea, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, da#1→ab, da#3→de+cd, da#5→ea, de#1→ef, de#3→cd, ea#1→da+ab, ea#3→ef+de, ea#5→ga, ef#1→fg, ef#3→de, fg#1→ga, fg#3→ef, ga#1→ab, ga#3→fg
F1 A2 first: 20 joint faces: ab#1→bc, ab#3→ga, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, da#1→ab, da#3→de+cd, da#5→ea, de#1→ef, de#3→cd, ea#1→da, ea#3→ef+de, ea#5→ga, ef#1→fg, ef#3→de, fg#1→ga, fg#3→ef, ga#1→ab, ga#3→fg
F1 B first: 21 splits, 22 fragments
F1 B first: 20 joint faces: ab#1→ga, ab#5→bc, bc#1→ab, bc#5→cd, cd#4→bc, cd#5→de, da#3→ab, da#5→ea, da#6→cd+de, de#4→cd, de#5→ef, ea#3→ga, ea#4→da, ea#6→de+ef, ef#4→de, ef#5→fg, fg#4→ef, fg#5→ga, ga#3→fg, ga#5→ab
F1 A2 rebuild: 20 joint faces: ab#1→bc, ab#3→ga, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, da#1→ab, da#3→de+cd, da#5→ea, de#1→ef, de#3→cd, ea#1→da, ea#3→ef+de, ea#5→ga, ef#1→fg, ef#3→de, fg#1→ga, fg#3→ef, ga#1→ab, ga#3→fg
F1 B rebuild: 21 splits, 22 fragments
F1 B rebuild: 20 joint faces: ab#1→ga, ab#5→bc, bc#1→ab, bc#5→cd, cd#4→bc, cd#5→de, da#3→ab, da#5→ea, da#6→cd+de, de#4→cd, de#5→ef, ea#3→ga, ea#4→da, ea#6→ef+de, ef#4→de, ef#5→fg, fg#4→ef, fg#5→ga, ga#3→fg, ga#5→ab
F2 A2 first: 20 joint faces: ab#1→bc, ab#3→ga, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, da#1→ab, da#3→de+cd, da#5→ea, de#1→ef, de#3→cd, ea#1→da, ea#3→ef+de, ea#5→ab+ga, ef#1→fg, ef#3→de, fg#1→ga, fg#3→ef, ga#1→ab, ga#3→fg
F2 B first: 27 splits, 28 fragments
F2 B first: 20 joint faces: ab#3→bc, ab#4→ga, bc#2→ab, bc#5→cd, cd#4→bc, cd#5→de, da#3→ab, da#4→cd+de, da#6→ea, de#4→cd, de#5→ef, ea#4→ga+ab, ea#5→de+ef, ea#6→da, ef#4→de, ef#5→fg, fg#4→ef, fg#5→ga, ga#1→fg, ga#5→ab
F2 A2 rebuild: 20 joint faces: ab#1→bc, ab#3→ga, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, da#1→ab, da#3→de+cd, da#5→ea, de#1→ef, de#3→cd, ea#1→da, ea#3→ef+de, ea#5→ab+ga, ef#1→fg, ef#3→de, fg#1→ga, fg#3→ef, ga#1→ab, ga#3→fg
F2 B rebuild: 26 splits, 27 fragments
F2 B rebuild: 20 joint faces: ab#0→ga, ab#5→bc, bc#1→ab, bc#5→cd, cd#4→bc, cd#5→de, da#0→ab, da#2→ea, da#6→de+cd, de#4→cd, de#5→ef, ea#4→ab+ga, ea#5→de+ef, ea#6→da, ef#4→de, ef#5→fg, fg#4→ef, fg#5→ga, ga#3→fg, ga#4→ab
F3 A2 first: 26 joint faces: ab#1→bc, ab#3→ha, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, da#1→ab, da#3→de+cd, da#5→ea, de#1→ef, de#3→cd, ea#1→da, ea#3→ef+de, ea#5→fa, ea#6→ab+ha, ef#1→fg, ef#3→de, fa#1→ea, fa#3→fg+ef, fa#5→ha, fg#1→gh, fg#3→ef, gh#1→ha, gh#3→fg, ha#1→ab, ha#3→gh
F3 B first: 29 splits, 30 fragments
F3 B first: 26 joint faces: ab#2→bc, ab#5→ha, bc#1→ab, bc#5→cd, cd#4→bc, cd#5→de, da#2→cd+de, da#4→ab, da#6→ea, de#1→ef, de#5→cd, ea#2→ef+de, ea#3→ha+ab, ea#5→da, ea#7→fa, ef#2→de, ef#5→fg, fa#2→ha, fa#5→ef+fg, fa#6→ea, fg#4→ef, fg#5→gh, gh#4→fg, gh#5→ha, ha#2→ab, ha#5→gh
F3 A2 rebuild: 26 joint faces: ab#1→bc, ab#3→ha, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, da#1→ab, da#3→de+cd, da#5→ea, de#1→ef, de#3→cd, ea#1→da, ea#3→ef+de, ea#5→fa, ea#6→ab+ha, ef#1→fg, ef#3→de, fa#1→ea, fa#3→fg+ef, fa#5→ha, fg#1→gh, fg#3→ef, gh#1→ha, gh#3→fg, ha#1→ab, ha#3→gh
F3 B rebuild: 29 splits, 30 fragments
F3 B rebuild: 26 joint faces: ab#2→bc, ab#5→ha, bc#1→ab, bc#5→cd, cd#4→bc, cd#5→de, da#2→de+cd, da#4→ab, da#6→ea, de#1→ef, de#5→cd, ea#2→de+ef, ea#3→ha+ab, ea#5→da, ea#7→fa, ef#2→de, ef#5→fg, fa#2→ha, fa#5→fg+ef, fa#6→ea, fg#4→ef, fg#5→gh, gh#4→fg, gh#5→ha, ha#2→ab, ha#5→gh
E A2 first: 20 joint faces: ab#1→bc, ab#3→ga, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, da#1→ab, da#3→de+cd, da#5→ea, de#1→ef, de#3→cd, ea#1→da, ea#3→ef+de, ea#5→ab+ga, ef#1→fg, ef#3→de, fg#1→ga, fg#3→ef, ga#1→ab, ga#3→fg
E A2 rebuild: 20 joint faces: ab#1→bc, ab#3→ga, bc#1→cd, bc#3→ab, cd#1→de, cd#3→bc, da#1→ab, da#3→de+cd, da#5→ea, de#1→ef, de#3→cd, ea#1→da, ea#3→ef+de, ea#5→ab+ga, ef#1→fg, ef#3→de, fg#1→ga, fg#3→ef, ga#1→ab, ga#3→fg
Y1 A2 first: 24 joint faces: ab#1→bc, ab#3→ca, ab#4→da, ab#6→db, bc#1→ca, bc#3→ab, bc#4→db, bc#6→cd, ca#1→ab, ca#3→bc, ca#4→cd, ca#6→da, cd#1→da, cd#3→ca, cd#4→bc, cd#6→db, da#1→ca, da#3→cd, da#4→db, da#6→ab, db#1→ab, db#3→da, db#4→cd, db#6→bc
Y1 B first: 35 splits, 36 fragments
Y1 B first: 24 joint faces: ab#1→db, ab#2→ca, ab#3→bc, ab#4→da, bc#1→ab, bc#3→db, bc#6→cd, bc#7→ca, ca#1→ab, ca#3→cd, ca#4→da, ca#5→bc, cd#1→ca, cd#2→bc, cd#6→db, cd#7→da, da#3→cd, da#4→ca, da#5→ab, da#6→db, db#2→bc, db#3→ab, db#5→da, db#7→cd
Y1 A2 rebuild: 24 joint faces: ab#1→bc, ab#3→ca, ab#4→da, ab#6→db, bc#1→ca, bc#3→ab, bc#4→db, bc#6→cd, ca#1→ab, ca#3→bc, ca#4→cd, ca#6→da, cd#1→da, cd#3→ca, cd#4→bc, cd#6→db, da#0→ab, da#3→db, da#4→cd, da#7→ca, db#1→ab, db#3→da, db#4→cd, db#6→bc
Y1 B rebuild: 51 splits, 52 fragments
Y1 B rebuild: 24 joint faces: ab#0→db, ab#1→da, ab#3→ca, ab#4→bc, bc#2→ab, bc#5→db, bc#6→cd, bc#7→ca, ca#0→ab, ca#1→da, ca#3→cd, ca#4→bc, cd#3→ca, cd#4→bc, cd#5→da, cd#7→db, da#3→cd, da#4→ca, da#6→ab, da#7→db, db#0→bc, db#1→ab, db#5→da, db#7→cd
Y2 A2 first: 24 joint faces: ab#4→da, ab#5→ca, ab#6→db, ab#7→bc, bc#1→ca, bc#3→ab, bc#4→db, bc#6→cd, ca#1→ab, ca#3→bc, ca#4→cd, ca#6→da, cd#1→da, cd#3→ca, cd#4→bc, cd#6→db, da#1→ca, da#3→cd, da#4→db, da#6→ab, db#1→ab, db#3→da, db#4→cd, db#6→bc
Y2 A2 rebuild: 24 joint faces: ab#1→bc, ab#3→ca, ab#4→da, ab#6→db, bc#1→ca, bc#3→ab, bc#4→db, bc#6→cd, ca#1→ab, ca#3→bc, ca#4→cd, ca#6→da, cd#1→da, cd#3→ca, cd#4→bc, cd#6→db, da#1→ca, da#3→cd, da#4→db, da#6→ab, db#1→ab, db#3→da, db#4→cd, db#6→bc
YN A2 first: 24 joint faces: ab#1→bc, ab#3→ca, ab#4→da, ab#6→db, bc#1→ca, bc#3→ab, bc#4→db, bc#6→cd, ca#1→ab, ca#3→bc, ca#4→cd, ca#6→da, cd#1→da, cd#3→ca, cd#4→bc, cd#6→db, da#1→ca, da#3→cd, da#4→db, da#6→ab, db#1→ab, db#3→da, db#4→cd, db#6→bc
YN A2 rebuild: 24 joint faces: ab#1→bc, ab#3→ca, ab#4→da, ab#6→db, bc#1→ca, bc#3→ab, bc#4→db, bc#6→cd, ca#1→ab, ca#3→bc, ca#4→cd, ca#6→da, cd#1→da, cd#3→ca, cd#4→bc, cd#6→db, da#1→ca, da#3→cd, da#4→db, da#6→ab, db#1→ab, db#3→da, db#4→cd, db#6→bc
Q A2 first: 32 joint faces: ab#1→bc, ab#3→ca, ab#4→ea, ab#6→eb, bc#1→ca, bc#3→ab, bc#4→eb, bc#6→cd, ca#1→ab, ca#3→bc, ca#4→cd, ca#6→da, cd#1→da, cd#3→ca, cd#4→bc, cd#6→de, da#1→ca, da#3→cd, da#4→de, da#6→ea, de#1→ea, de#3→da, de#4→cd, de#6→eb, ea#1→da, ea#3→de, ea#4→eb, ea#6→ab, eb#1→ab, eb#3→ea, eb#4→de, eb#6→bc
Q B first: 53 splits, 54 fragments
Q B first: 32 joint faces: ab#3→ea, ab#4→ca, ab#5→eb, ab#6→bc, bc#2→ab, bc#3→eb, bc#6→cd, bc#7→ca, ca#0→ab, ca#3→da, ca#5→bc, ca#7→cd, cd#4→ca, cd#5→bc, cd#6→de, cd#7→da, da#0→de, da#2→cd, da#5→ea, da#6→ca, de#1→da, de#2→ea, de#5→eb, de#7→cd, ea#1→ab, ea#5→da, ea#6→eb, ea#7→de, eb#1→bc, eb#2→ab, eb#3→ea, eb#7→de
Q A2 rebuild: 32 joint faces: ab#1→bc, ab#3→ca, ab#4→ea, ab#6→eb, bc#1→ca, bc#3→ab, bc#4→eb, bc#6→cd, ca#1→ab, ca#3→bc, ca#4→cd, ca#6→da, cd#1→da, cd#3→ca, cd#4→bc, cd#6→de, da#1→ca, da#3→cd, da#4→de, da#6→ea, de#1→ea, de#3→da, de#4→cd, de#6→eb, ea#1→da, ea#3→de, ea#4→eb, ea#6→ab, eb#1→ab, eb#3→ea, eb#4→de, eb#6→bc
Q B rebuild: 52 splits, 53 fragments
Q B rebuild: 32 joint faces: ab#3→ea, ab#4→ca, ab#5→eb, ab#6→bc, bc#3→ab, bc#5→eb, bc#6→cd, bc#7→ca, ca#0→ab, ca#3→da, ca#5→bc, ca#7→cd, cd#3→ca, cd#4→bc, cd#5→de, cd#7→da, da#0→de, da#2→cd, da#5→ea, da#6→ca, de#1→da, de#2→ea, de#5→eb, de#7→cd, ea#1→ab, ea#5→da, ea#6→eb, ea#7→de, eb#1→bc, eb#2→ab, eb#3→ea, eb#7→de
Z A2 first: 14 joint faces: da#1→ab, da#3→bd, ab#1→bd, ab#3→da, ab#5→bc, bd#1→da, bd#3→ab, bd#4→bc, bd#6→cd, bc#1→cd, bc#3→bd, bc#4→ab, cd#1→bd, cd#3→bc
Z A2 first cd#5 → exterior
Z A2 rebuild: 14 joint faces: da#1→ab, da#3→bd, ab#1→bd, ab#3→da, ab#5→bc, bd#1→da, bd#3→ab, bd#4→bc, bd#6→cd, bc#1→cd, bc#3→bd, bc#4→ab, cd#1→bd, cd#3→bc
Z A2 rebuild cd#5 → exterior
```
