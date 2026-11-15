"""Validate the recorded observations without regenerating geometry."""
import collections
import json
from pathlib import Path

root = Path(__file__).parent

def read(name):
    return json.loads((root / name).read_text())

rows = read('baseline-runs.json')
assert len(rows) == 56
assert set(collections.Counter((r['join'], r['update']) for r in rows).values()) == {14}
for row in rows:
    for phase in ['before', 'after', 'restored']:
        value = row[phase]
        assert value['featureErrors'] == 0
        assert abs(value['wallVolume'] - 25123080000) <= 100
        assert len(value['colors']) == 3
        for face in value['colors']:
            if face['rgb'] == [54, 111, 168]:
                assert abs(face['point'][0] - (value['split'] - 60)) <= 0.01
                assert abs(face['normal'][0] + 1) <= 1e-6
            if face['rgb'] == [50, 153, 102]:
                assert abs(face['point'][0] - (value['split'] + 60)) <= 0.01
                assert abs(face['normal'][0] - 1) <= 1e-6

appearance = read('appearance.json')
assert appearance['doorAddedAcrossOldPoint']['ok'] is True
assert appearance['wrongBodyPaint']['ok'] is False
assert appearance['wrongRoomExpectation']['ok'] is False
assert appearance['determinism']['cadJsonIdentical'] is True
assert appearance['determinism']['displayIdentical'] is True
for color in appearance['doorAddedAcrossOldPoint']['colors']:
    if color['rgb'] in [[54, 111, 168], [50, 153, 102]]:
        assert color['body'] == 'v1-r0'
        assert 100 <= color['point'][1] <= 3940
        assert abs(color['area'] - 5526000) <= 1

joins = read('decided-joins.json')
assert sum(row.get('decided', {}).get('result') == 'pass' for row in joins) == 30
assert sum(row.get('decided', {}).get('result') == 'rejected-before-CAD' for row in joins) == 3
for row in joins:
    value = row.get('decided', {})
    if value.get('result') == 'pass':
        assert abs(value['volumeError']) <= 100
        assert value['model']['featureErrors'] == []
        assert value['model']['allClosed'] is True
        assert value['allSimple'] is True
        if isinstance(value['model']['union'], dict):
            assert abs(value['model']['volume'] - value['model']['union']['volume']) <= 100
    if 'rejected' in row:
        assert row['rejected'] is True

for name in ['batch6.jsonl', 'batch24-grouped.jsonl', 'batch24-append.jsonl']:
    batch = [json.loads(line) for line in (root / name).read_text().splitlines()]
    assert len(batch) == 15
    assert all(row['ok'] and not row['problems'] for row in batch)
    assert all(row['totalMs'] > 0 for row in batch)
    assert set(collections.Counter(row['method'] for row in batch).values()) == {5}
    if name != 'batch24-grouped.jsonl':
        for index in range(batch[0]['ops']):
            assert len({row['perOp'][index][3] for row in batch}) == 1

api = read('requests.json')
assert api['regenerationDeterministic']['cadJsonIdentical'] is True
assert api['regenerationDeterministic']['displayIdentical'] is True
for furniture in [0, 10, 30]:
    for value in api[f'perRequest-furniture{furniture}'].values():
        if isinstance(value, dict) and 'samples' in value:
            assert len(value['samples']) == 5
            assert all(sample > 0 for sample in value['samples'])
print('Verified 56 baseline trials, 35 join observations, appearance mutations, 45 batch trials and request costs.')
