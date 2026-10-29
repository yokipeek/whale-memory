# -*- coding: utf-8 -*-
"""重新排布列坐标：保证相邻列之间有 ≥62px 的空白（放得下标签）。"""
import json, io, sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
P = 'candidate.json'
d = json.load(open(P, encoding='utf-8'))

# 每列最宽组件宽度
cols = {}
for c in d['components']:
    cols.setdefault(c['pos'][0], []).append(c)

order = sorted(cols)
GAP = 60
x = 16
mapping = {}
for old in order:
    mapping[old] = x
    widest = max(c['size'][0] for c in cols[old])
    x += widest + GAP

for c in d['components']:
    c['pos'][0] = mapping[c['pos'][0]]

maxx = max(c['pos'][0] + c['size'][0] for c in d['components'])
print('最右:', maxx, '| 总宽需要 ≤1216')
xs = sorted({c['pos'][0] for c in d['components']})
for a, b in zip(xs, xs[1:]):
    wa = max(c['size'][0] for c in d['components'] if c['pos'][0] == a)
    print(f'  列 {a:4} → {b:4}: 空白 {b - (a + wa):3}px')

json.dump(d, open(P, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print('已写回')
