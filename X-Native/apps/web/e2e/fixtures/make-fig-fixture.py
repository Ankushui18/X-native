import struct, zlib, zipfile, io, sys
from pathlib import Path

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
defs=["Vector","Color","Paint","GUID","Matrix","NodeChange","Message","Effect"]
KIND={"Vector":1,"Color":1,"Paint":2,"GUID":1,"Matrix":1,"NodeChange":2,"Message":2,"Effect":2}  # 1=struct 2=message
FIELDS={
 "Effect":[("type","string",1),("color","Color",2),("offset","Vector",3),("radius","float",4),("visible","bool",5)],
 "Vector":[("x","float",0),("y","float",0)],
 "Color":[("r","float",0),("g","float",0),("b","float",0),("a","float",0)],
 "Paint":[("type","string",1),("color","Color",2),("opacity","float",3),("visible","bool",4)],
 "GUID":[("sessionID","uint",0),("localID","uint",0)],
 "Matrix":[("m00","float",0),("m01","float",0),("m02","float",0),("m10","float",0),("m11","float",0),("m12","float",0)],
 "NodeChange":[("guid","GUID",1),("type","string",2),("name","string",3),("visible","bool",4),
               ("opacity","float",5),("size","Vector",6),("transform","Matrix",7),
               ("fillPaints","Paint",8),("strokePaints","Paint",9),("strokeWeight","float",10),
               ("cornerRadius","float",11),("characters","string",12),("fontSize","float",13),("phase","string",14),("locked","bool",15),("textAlignHorizontal","string",16),("strokeAlign","string",17),("strokeCap","string",18),("strokeJoin","string",19),("strokeDashes","float",20),("blendMode","string",21),("effects","Effect",22)],
 "Message":[("nodeChanges","NodeChange",1)],
}
ARRAY={("NodeChange","effects"),("NodeChange","strokeDashes"),("NodeChange","fillPaints"),("NodeChange","strokePaints"),("Message","nodeChanges")}

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

def node(sid,lid,ty,name,w,h,x,y,fill=None,stroke=None,sw=0,radius=0,chars=None,fs=0,locked=False,align=None,stroke_align=None,cap=None,join=None,dashes=None,blend=None,effects=None):
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
    if locked: o+=varuint(15)+bytes([1])
    if align is not None: o+=varuint(16)+s(align)
    for field,value in [(17,stroke_align),(18,cap),(19,join)]:
        if value is not None: o+=varuint(field)+s(value)
    if dashes is not None:
        o+=varuint(20)+varuint(len(dashes))
        for dash in dashes: o+=varfloat(dash)
    if blend is not None: o+=varuint(21)+s(blend)
    if effects is not None:
        o+=varuint(22)+varuint(len(effects))
        for fx in effects: o+=fx
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
# Separate regression fixture; the historical sample.fig is never overwritten.
state = "--state" in sys.argv
if state:
    nodes = [node(1,1,"CANVAS","State",0,0,0,0)] + [
        node(1,i+2,"TEXT",align,200,24,20,40+i*40,fill=color(0,0,0),
             chars="State " + align,fs=18,locked=(i == 2),align=align)
        for i,align in enumerate(["LEFT", "CENTER", "RIGHT", "JUSTIFIED"])
    ]
strokes = "--strokes" in sys.argv
if strokes:
    nodes = [node(1,1,"CANVAS","Strokes",0,0,0,0)] + [
        node(1,i+2,"RECTANGLE",align,100,50,20+i*120,40,fill=color(1,0,0),
             stroke=color(0,0,0),sw=2,stroke_align=align,cap=cap,join=join,dashes=dash)
        for i,(align,cap,join,dash) in enumerate([
            ("INSIDE","ROUND","BEVEL",[8,4]),
            ("CENTER","SQUARE","ROUND",[6]),
            ("OUTSIDE","NONE","MITER",[]),
        ])
    ]
effect_case = "--effects" in sys.argv
if effect_case:
    def effect(ty,radius,c=None,x=0,y=0):
        out=varuint(1)+s(ty)
        if c is not None: out+=varuint(2)+c
        out+=varuint(3)+varfloat(x)+varfloat(y)
        return out+varuint(4)+varfloat(radius)+varuint(5)+bytes([1])+varuint(0)
    nodes = [
        node(1,1,"CANVAS","Effects",0,0,0,0),
        node(1,2,"RECTANGLE","BlendedEffects",100,50,20,40,fill=color(1,1,1),stroke=color(0,0,0),sw=2,blend="MULTIPLY",effects=[
            effect("DROP_SHADOW",6,color(1,0,0,0.5),5,-3),
            effect("INNER_SHADOW",2,color(0,0,1),-2,4),
            effect("LAYER_BLUR",8), effect("BACKGROUND_BLUR",4),
        ]),
        node(1,3,"RECTANGLE","ForegroundAlias",100,50,140,40,fill=color(1,1,1),blend="SOFT_LIGHT",effects=[effect("FOREGROUND_BLUR",3)]),
        node(1,4,"FRAME","Passthrough",100,50,260,40,fill=color(1,1,1),blend="PASS_THROUGH"),
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

target = Path(__file__).with_name("effects-blend.fig") if effect_case else Path(__file__).with_name("stroke-options.fig") if strokes else Path(__file__).with_name("state-text.fig") if state else Path("/tmp/test.fig")
z=zipfile.ZipFile(target,"w",zipfile.ZIP_DEFLATED)
entry = zipfile.ZipInfo("canvas.fig", date_time=(2026,9,27,0,0,0))
entry.compress_type = zipfile.ZIP_DEFLATED
z.writestr(entry,bytes(canvas)); z.close()
print("wrote", target, target.stat().st_size, "bytes")
