#!/usr/bin/env python3
"""Fetch a subset of GuitarSet (CC-BY 4.0, Xi et al. 2018) without downloading
the multi-GB zips: reads the zip central directory over HTTP range requests
and inflates only the entries we want.

Usage: ./fetch_guitarset.py [--all-covered] [name-fragment ...]
Default subset: comp + solo takes of the 7 progressions fully covered by
data/chords.json, for all 6 players.  Writes testdata/audio/*.wav and
testdata/jams/*.jams.
"""
import io, json, os, struct, sys, urllib.request, zipfile, zlib

REC = 'https://zenodo.org/api/records/3371780/files/{}/content'
AUDIO_ZIP = REC.format('audio_mono-mic.zip')
HERE = os.path.dirname(os.path.abspath(__file__))
PROGRESSIONS = ['SS3-98-C', 'Rock3-148-C', 'Jazz3-150-C', 'Rock1-130-A',
                'Jazz1-130-D', 'Funk1-97-C', 'Jazz3-150-C']

def http_range(url, start, end):
    req = urllib.request.Request(url, headers={'Range': f'bytes={start}-{end}'})
    with urllib.request.urlopen(req) as r:
        assert r.status == 206, r.status
        return r.read()

def content_length(url):
    req = urllib.request.Request(url, method='HEAD')
    with urllib.request.urlopen(req) as r:
        return int(r.headers['Content-Length'])

def central_directory(url):
    size = content_length(url)
    tail = http_range(url, max(0, size - 256 * 1024), size - 1)
    i = tail.rfind(b'PK\x05\x06')
    assert i >= 0, 'no EOCD'
    (_, _, _, _, n, cd_size, cd_off, _) = struct.unpack('<4sHHHHIIH', tail[i:i + 22])
    if cd_off == 0xFFFFFFFF:  # zip64
        j = tail.rfind(b'PK\x06\x06')
        (_, _, _, _, _, _, _, n, cd_size, cd_off) = struct.unpack('<4sQHHIIQQQQ', tail[j:j + 56])
    cd = http_range(url, cd_off, cd_off + cd_size - 1)
    entries = {}
    p = 0
    while p < len(cd):
        (sig, _, _, flag, method, _, _, crc, csize, usize, fnlen, exlen, cmlen,
         _, _, _, loff) = struct.unpack('<4sHHHHHHIIIHHHHHII', cd[p:p + 46])
        assert sig == b'PK\x01\x02'
        name = cd[p + 46:p + 46 + fnlen].decode()
        entries[name] = dict(method=method, csize=csize, usize=usize, loff=loff, crc=crc)
        p += 46 + fnlen + exlen + cmlen
    return entries

def fetch_entry(url, e):
    hdr = http_range(url, e['loff'], e['loff'] + 29)
    (sig, _, _, _, _, _, _, _, _, fnlen, exlen) = struct.unpack('<4sHHHHHIIIHH', hdr)
    assert sig == b'PK\x03\x04'
    start = e['loff'] + 30 + fnlen + exlen
    raw = http_range(url, start, start + e['csize'] - 1)
    if e['method'] == 0:
        data = raw
    elif e['method'] == 8:
        data = zlib.decompressobj(-15).decompress(raw)
    else:
        raise RuntimeError(f'unsupported method {e["method"]}')
    assert len(data) == e['usize']
    assert (zlib.crc32(data) & 0xFFFFFFFF) == e['crc'], 'crc mismatch'
    return data

def main(argv):
    want_all = '--all-covered' in argv
    frags = [a for a in argv if not a.startswith('--')]
    os.makedirs(os.path.join(HERE, 'audio'), exist_ok=True)
    os.makedirs(os.path.join(HERE, 'jams'), exist_ok=True)

    # annotations: local zip (39 MB, already downloaded) or fetch
    ann_path = os.path.join(HERE, 'annotation.zip')
    if not os.path.exists(ann_path):
        urllib.request.urlretrieve(REC.format('annotation.zip'), ann_path)
    ann = zipfile.ZipFile(ann_path)

    print('reading central directory…', file=sys.stderr)
    entries = central_directory(AUDIO_ZIP)
    names = sorted(entries)
    if frags:
        sel = [n for n in names if any(f in n for f in frags)]
    else:
        sel = [n for n in names if any(p in n for p in PROGRESSIONS)]
        if not want_all:
            # default: all comp takes + one solo per player (rotating progression)
            comp = [n for n in sel if '_comp' in n]
            solos = [n for n in sel if '_solo' in n]
            pick = []
            for i in range(6):
                cand = [n for n in solos if n.startswith(f'0{i}_') and PROGRESSIONS[i % len(PROGRESSIONS)] in n]
                pick += cand[:1]
            sel = comp + pick
    print(f'{len(sel)} files selected', file=sys.stderr)
    for n in sel:
        out = os.path.join(HERE, 'audio', os.path.basename(n))
        base = os.path.basename(n).replace('_mic.wav', '')
        jn = base + '.jams'
        jout = os.path.join(HERE, 'jams', jn)
        if not os.path.exists(jout):
            with open(jout, 'wb') as f: f.write(ann.read(jn))
        if os.path.exists(out) and os.path.getsize(out) == entries[n]['usize']:
            continue
        print(f'  {n} ({entries[n]["csize"]/1e6:.1f} MB)', file=sys.stderr)
        with open(out, 'wb') as f: f.write(fetch_entry(AUDIO_ZIP, entries[n]))
    print('done', file=sys.stderr)

if __name__ == '__main__':
    main(sys.argv[1:])
