#!/usr/bin/env python3
"""Trace every printed canal/rail route on assets/board.jpg.

Dijkstra over a track-colour mask from one location's printed spaces to the
other's, then simplified to a short polyline. Output: three-src/routes.js
(normalised board coordinates).  Farm-brewery routes get the main line plus a
spur from the farm to that line.  Input geometry: /tmp/geo.json (dumped from
gameData.js + boardAssets.js).  Manual overrides live in OVERRIDES below.
"""
import json, heapq, sys
import numpy as np
from PIL import Image

N = 1024                                  # search grid
geo = json.load(open('/tmp/geo.json'))
img = np.asarray(Image.open('assets/board.jpg').convert('RGB')).astype(int)
H = img.shape[0]; C = H // N
r, g, b = img[..., 0], img[..., 1], img[..., 2]
mask = (b > 120) & (b - r > 20) & (g - r > 5)
cell = mask.reshape(N, C, N, C).mean(axis=(1, 3))
def boxblur(a, r):
    p = np.pad(a, r, mode='edge').cumsum(0).cumsum(1)
    p = np.pad(p, ((1, 0), (1, 0)))
    k = 2 * r + 1
    return (p[k:, k:] - p[:-k, k:] - p[k:, :-k] + p[:-k, :-k]) / (k * k)
# a printed route is a band whose two light edges are ~12 cells apart:
# blurring makes the middle of the band the cheapest place to walk
band = boxblur(cell, 7)
# rails are printed as near-black sleepers: their middle is the best path
dark = (img.max(axis=2) < 40).reshape(N, C, N, C).mean(axis=(1, 3))
rail = boxblur(dark, 2)
COST = 1.0 + 30.0 * np.clip(1.0 - np.maximum(band / 0.12, rail / 0.25), 0, 1)
SW, SH = 38.8 / 900 / 2, 36.3 / 850 / 2
def boxes(loc, pad=0.004):
    L = geo['loc'][loc]; out = []
    for u, v in L['slots']:
        out.append((u - SW - pad, v - SH - pad, u + SW + pad, v + SH + pad))
    if loc in geo['banners']:
        x0, y0, x1, y1 = geo['banners'][loc]; out.append((x0 - pad, y0 - pad, x1 + pad, y1 + pad))
    return out
def region(loc, pad=0.004):
    m = np.zeros((N, N), bool)
    for x0, y0, x1, y1 in boxes(loc, pad):
        m[max(0, int(y0 * N)):int(y1 * N) + 1, max(0, int(x0 * N)):int(x1 * N) + 1] = True
    return m

ALL = {k: region(k) for k in geo['loc']}
OFF, ON = 12.0, 1.0

def dijkstra(src, dst, avoid):
    dist = np.full((N, N), np.inf); prev = {}
    pq = []
    for y, x in zip(*np.nonzero(src)):
        dist[y, x] = 0; heapq.heappush(pq, (0.0, y, x))
    nb = [(-1, 0, 1), (1, 0, 1), (0, -1, 1), (0, 1, 1), (-1, -1, 1.414), (-1, 1, 1.414), (1, -1, 1.414), (1, 1, 1.414)]
    while pq:
        c, y, x = heapq.heappop(pq)
        if c > dist[y, x]: continue
        if dst[y, x]:
            path = [(y, x)]
            while (y, x) in prev: y, x = prev[(y, x)]; path.append((y, x))
            return path[::-1]
        for dy, dx, w in nb:
            ny, nx = y + dy, x + dx
            if not (0 <= ny < N and 0 <= nx < N): continue
            if avoid[ny, nx]: continue
            nc = c + w * COST[ny, nx]
            if nc < dist[ny, nx]:
                dist[ny, nx] = nc; prev[(ny, nx)] = (y, x); heapq.heappush(pq, (nc, ny, nx))
    return None

def rdp(pts, eps):
    if len(pts) < 3: return pts
    a, b = np.array(pts[0]), np.array(pts[-1])
    ab = b - a; L = np.hypot(*ab) or 1
    dmax, idx = 0, 0
    for i in range(1, len(pts) - 1):
        p = np.array(pts[i]); dd = abs(ab[0] * (a[1] - p[1]) - ab[1] * (a[0] - p[0])) / L
        if dd > dmax: dmax, idx = dd, i
    if dmax > eps: return rdp(pts[:idx + 1], eps)[:-1] + rdp(pts[idx:], eps)
    return [pts[0], pts[-1]]

def to_uv(path):
    pts = [((x + 0.5) / N, (y + 0.5) / N) for y, x in path]
    return [[round(u, 4), round(v, 4)] for u, v in rdp(pts, 2.5 / N)]

def avoid_except(*keep):
    m = np.zeros((N, N), bool)
    for k, reg in ALL.items():
        if k not in keep: m |= region(k, -0.002)
    return m

# Waypoints (board pixels, 2048 px image) on the printed line, for links whose
# cheapest path would otherwise follow a neighbouring parallel route.
OVERRIDES = json.load(open(sys.argv[1] if len(sys.argv) > 1 else 'scripts/route-overrides.json'))

def disc(px, py, r=4):
    m = np.zeros((N, N), bool); x, y = int(px * N / H), int(py * N / H)
    m[max(0, y - r):y + r + 1, max(0, x - r):x + r + 1] = True
    return m

def routed(a, b):
    avoid = avoid_except(a, b)
    stops = [region(a)] + [disc(*p) for p in OVERRIDES.get(f'{a}-{b}', [])] + [region(b)]
    path = []
    for s, t in zip(stops, stops[1:]):
        seg = dijkstra(s, t, avoid)
        if seg is None: return None
        path += seg if not path else seg[1:]
    return path

routes = {}
for c in geo['conns']:
    a, b = c['cities']
    path = routed(a, b)
    if path is None: print('NO PATH', c['id'], file=sys.stderr); continue
    entry = {'line': to_uv(path)}
    if c['via']:
        on = np.zeros((N, N), bool)
        for y, x in path: on[y, x] = True
        spur = dijkstra(region(c['via']), on, avoid_except(a, b, c['via']))
        entry['spur'] = to_uv(spur)
        entry['via'] = c['via']
    routes[c['id']] = entry
    print(c['id'], len(entry['line']), 'pts', '+spur' if c['via'] else '', file=sys.stderr)

with open('three-src/routes.js', 'w') as f:
    f.write('// Generated by scripts/trace-routes.py: printed route centre lines in board UV.\n')
    f.write('export const ROUTES = ' + json.dumps(routes, separators=(',', ':')) + ';\n')
