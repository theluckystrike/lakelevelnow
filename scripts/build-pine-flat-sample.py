"""Reproduce the public sample from the existing delivered Pine Flat ZIP.
Usage: python3 scripts/build-pine-flat-sample.py /path/to/pine-flat-lake.zip
Reads a supplied artifact only; never performs checkout or accesses credentials.
"""
import csv, hashlib, io, json, pathlib, sys, zipfile
artifact = pathlib.Path(sys.argv[1])
with zipfile.ZipFile(artifact) as z:
    prefix = 'Pine-Flat-Lake Lake Level Almanac/'
    rows = list(csv.DictReader(io.StringIO(z.read(prefix+'daily-record.csv').decode())))
    monthly = list(csv.DictReader(io.StringIO(z.read(prefix+'monthly-normals.csv').decode())))
september = [r for r in rows if r['date'][5:7] == '09']
month = next(r for r in monthly if r['month'] == 'September')
assert len(rows) == 13451 and len(september) == int(month['n_observations'])
assert len({r['date'] for r in rows}) == len(rows)
assert all(r['site_no'] == 'PNF' and r['parameter'] == '6' for r in rows)
below = sum(float(r['elevation_ft']) < 800 for r in september)
data = dict(source='CDEC', station='PNF', sourceUrl='https://cdec.water.ca.gov/dynamicapp/staMeta?station_id=PNF',
    recordStart=rows[0]['date'], recordEnd=rows[-1]['date'], observations=len(rows),
    artifactSha256=hashlib.sha256(artifact.read_bytes()).hexdigest(), month='September', monthlyObservations=len(september),
    p25Ft=float(month['p25_ft']), medianFt=float(month['median_ft']), p75Ft=float(month['p75_ft']),
    exampleThresholdFt=800, belowThresholdObservations=below, belowThresholdPercent=round(below/len(september)*100,1),
    method='September rows only, strictly below 800 ft; observed days are counted equally, missing dates are excluded; source uses CDEC station datum. Derived from the currently delivered product ZIP.')
pathlib.Path('src/data/pine-flat-sample.json').write_text(json.dumps(data, indent=2)+'\n')
print('Generated sample from', len(rows), 'delivered observations; September threshold:', below, '/', len(september))
