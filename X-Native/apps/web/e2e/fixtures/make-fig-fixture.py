import struct, zlib, zipfile, io

def varuint(v):
    out=bytearray()
    while True:
        b=v&127; v>>=7
        if v: out.append(b|128)
        else: out.append(b); break
    return bytes(out)

def varint(v):  # zigzag
    return varuint((v<<1)^(v>>31) if v>=0 else ((-v-1)<<1)|1) if False else varuint((v<<1) if v>=0 else ((-v)<<1)-1)

def s(x): return x.encode()+b"\0"

def varfloat(f):
    if f==0.0: return b"\0"
    bits=struct.unpack("<I",struct.pack("<f",f))[0]
    rot=((bits<<9)|(bits>>23))&0xFFFFFFFF   # inverse of decoder's rotate-right-9
    return struct.pack("<I",rot)

BUILTIN={"bool":0,"byte":1,"int":2,"uint":3,"float":4,"string":5,"int64":6,"uint64":7}
def tycode(t, defs):
    if t in BUILTIN: return ~BUILTIN[t]      # negative => builtin
    return defs.index(t)                      # non-negative => def index

# --- schema: enough of Figma's shape to exercise the decoder
defs=["Vector","Color","Paint","GUID","Matrix","NodeChange","Message"]
KIND={"Vector":1,"Color":1,"Paint":2,"GUID":1,"Matrix":1,"NodeChange":2,"Message":2}  # 1=struct 2=message
FIELDS={
 "Vector":[("x","float",0),("y","float",0)],
 "Color":[("r","float",0),("g","float",0),("b","float",0),("a","float",0)],
 "Paint":[("type","string",1),("color","Color",2),("opacity","float",3),("visible","bool",4)],
 "GUID":[("sessionID","uint",0),("localID","uint",0)],
 "Matrix":[("m00","float",0),("m01","float",0),("m02","float",0),("m10","float",0),("m11","float",0),("m12","float",0)],
 "NodeChange":[("guid","GUID",1),("type","string",2),("name","string",3),("visible","bool",4),
               ("opacity","float",5),("size","Vector",6),("transform","Matrix",7),
               ("fillPaints","Paint",8),("strokePaints","Paint",9),("strokeWeight","float",10),
               ("cornerRadius","float",11),("characters","string",12),("fontSize","float",13),("phase","string",14)],
 "Message":[("nodeChanges","NodeChange",1)],
}
ARRAY={("NodeChange","fillPaints"),("NodeChange","strokePaints"),("Message","nodeChanges")}

sch=bytearray(); sch+=varuint(len(defs))
for d in defs:
    sch+=s(d); sch.append(KIND[d]); sch+=varuint(len(FIELDS[d]))
    for (fn,ft,fv) in FIELDS[d]:
        sch+=s(fn); sch+=varint(tycode(ft,defs))
        sch.append(1 if (d,fn) in ARRAY else 0); sch+=varuint(fv)

def color(r,g,b,a=1.0): return varfloat(r)+varfloat(g)+varfloat(b)+varfloat(a)
def paint(c):  # message
    out=bytearray()
    out+=varuint(1)+s("SOLID"); out+=varuint(2)+c
    out+=varuint(3)+varfloat(1.0); out+=varuint(4)+bytes([1]); out+=varuint(0)
    return bytes(out)
def matrix(x,y): return varfloat(1)+varfloat(0)+varfloat(x)+varfloat(0)+varfloat(1)+varfloat(y)

def node(sid,lid,ty,name,w,h,x,y,fill=None,stroke=None,sw=0,radius=0,chars=None,fs=0):
    o=bytearray()
    o+=varuint(1)+varuint(sid)+varuint(lid)
    o+=varuint(2)+s(ty); o+=varuint(3)+s(name)
    o+=varuint(4)+bytes([1]); o+=varuint(5)+varfloat(1.0)
    o+=varuint(6)+varfloat(w)+varfloat(h)
    o+=varuint(7)+matrix(x,y)
    if fill is not None: o+=varuint(8)+varuint(1)+paint(fill)
    if stroke is not None:
        o+=varuint(9)+varuint(1)+paint(stroke); o+=varuint(10)+varfloat(sw)
    if radius: o+=varuint(11)+varfloat(radius)
    if chars is not None:
        o+=varuint(12)+s(chars); o+=varuint(13)+varfloat(fs)
    o+=varuint(0)
    return bytes(o)

msg=bytearray()
nodes=[
 node(1,1,"CANVAS","Page 1",0,0,0,0),
 node(1,2,"FRAME","Home",320,240,100,50,fill=color(1,1,1)),
 node(1,3,"RECTANGLE","FigCard",120,60,120,70,fill=color(1,0,0),stroke=color(0,0,1),sw=2,radius=8),
 node(1,4,"ELLIPSE","FigDot",50,50,280,70,fill=color(0,0.8,0)),
 node(1,5,"TEXT","FigLabel",200,24,120,160,chars="Figma Hello",fs=18),
]
msg+=varuint(1)+varuint(len(nodes))
for n in nodes: msg+=n
msg+=varuint(0)

def raw_deflate(b):
    c=zlib.compressobj(9,zlib.DEFLATED,-15)
    return c.compress(b)+c.flush()

canvas=bytearray(b"fig-kiwi"+struct.pack("<I",1))
for chunk in (raw_deflate(bytes(sch)), raw_deflate(bytes(msg))):
    canvas+=struct.pack("<I",len(chunk))+chunk

z=zipfile.ZipFile("/tmp/test.fig","w",zipfile.ZIP_DEFLATED)
z.writestr("canvas.fig",bytes(canvas)); z.close()
print("wrote /tmp/test.fig", __import__("os").path.getsize("/tmp/test.fig"),"bytes")
