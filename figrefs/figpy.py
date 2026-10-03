
import zipfile, struct, zlib

TYPES = ['bool','byte','int','uint','float','string','int64','uint64']
KINDS = ['ENUM','STRUCT','MESSAGE']

class BB:
    def __init__(s, d): s.d=d; s.i=0
    def byte(s):
        b=s.d[s.i]; s.i+=1; return b
    def read_varuint(s):
        v=0; sh=0
        while True:
            b=s.byte(); v |= (b & 127) << sh
            if not (b & 128) or sh>=35: break
            sh+=7
        return v & 0xFFFFFFFF
    def read_varint(s):
        v=s.read_varuint()
        if v >= 0x80000000: v -= 0x100000000
        return (~(v >> 1)) if (v & 1) else (v >> 1)
    def read_varuint64(s):
        v=0; sh=0
        while True:
            b=s.byte(); v |= (b & 127) << sh
            if not (b & 128) or sh>=63: break
            sh+=7
        return v
    def read_varint64(s):
        v=s.read_varuint64()
        return (~(v >> 1)) if (v & 1) else (v >> 1)
    def read_string(s):
        out=bytearray()
        while True:
            b=s.d[s.i]
            if b==0: s.i+=1; break
            out.append(b); s.i+=1
        return out.decode('utf-8','replace')
    def read_varfloat(s):
        first=s.d[s.i]
        if first==0: s.i+=1; return 0.0
        bits=first | s.d[s.i+1]<<8 | s.d[s.i+2]<<16 | s.d[s.i+3]<<24
        s.i+=4
        bits=((bits<<23)|(bits>>9)) & 0xFFFFFFFF
        return struct.unpack('<f', struct.pack('<I', bits))[0]

def decode_binary_schema(d):
    bb=BB(d); n=bb.read_varuint(); defs=[]
    for _ in range(n):
        name=bb.read_string(); kind=KINDS[bb.byte()]; fc=bb.read_varuint(); fields=[]
        for _ in range(fc):
            fn=bb.read_string(); t=bb.read_varint(); arr=bool(bb.byte()&1); val=bb.read_varuint()
            fields.append({'name':fn,'type':None if kind=='ENUM' else t,'isArray':arr,'value':val,'isDeprecated':False})
        defs.append({'name':name,'kind':kind,'fields':fields})
    for i,defn in enumerate(defs):
        for f in defn['fields']:
            t=f['type']
            if t is None: continue
            f['type']=TYPES[~t] if t<0 else defs[t]['name']
    return defs

class Dec:
    def __init__(s,defs,bb): s.defs={d['name']:d for d in defs}; s.em={}; s.bb=bb
    def enumidx(s,name):
        if name not in s.em: s.em[name]={f['value']:f['name'] for f in s.defs[name]['fields']}
        return s.em[name]
    def value(s,t,arr):
        bb=s.bb
        if arr:
            n=bb.read_varuint()
            if t=='byte': return bytes([bb.byte() for _ in range(n)])
            return [s.one(t) for _ in range(n)]
        return s.one(t)
    def one(s,t):
        if t=='bool': return bool(s.bb.byte())
        if t=='byte': return s.bb.byte()
        if t=='int': return s.bb.read_varint()
        if t=='uint': return s.bb.read_varuint()
        if t=='float': return s.bb.read_varfloat()
        if t=='string': return s.bb.read_string()
        if t=='int64': return s.bb.read_varint64()
        if t=='uint64': return s.bb.read_varuint64()
        d=s.defs[t]
        if d['kind']=='ENUM':
            v=s.bb.read_varuint(); return s.enumidx(t).get(v, v)
        if d['kind']=='STRUCT':
            return {f['name']: s.value(f['type'], f['isArray']) for f in d['fields']}
        out={}
        while True:
            sel=s.bb.read_varuint()
            if sel==0: break
            f=next((f for f in d['fields'] if f['value']==sel), None)
            if f is None: raise ValueError(f"unknown field {sel} in {t}")
            out[f['name']]=s.value(f['type'], f['isArray'])
        return out

def load_canvas(fn):
    z=zipfile.ZipFile(fn); data=z.read('canvas.fig')
    off=12; chunks=[]
    while off<len(data):
        ln=struct.unpack_from('<I',data,off)[0]; off+=4
        chunks.append(data[off:off+ln]); off+=ln
    def _zstd(b):
        import zstandard as zs; return zs.ZstdDecompressor().decompressobj().decompress(b)
    schema=_zstd(chunks[0]) if chunks[0][:4]==b'\x28\xb5\x2f\xfd' else zlib.decompress(chunks[0],-15)
    msg=chunks[1]
    if msg[:4]==b'\x28\xb5\x2f\xfd':
        import zstandard as zs; msg=_zstd(msg)
    else:
        msg=zlib.decompress(msg,-15)
    return decode_binary_schema(schema), msg, z
