"""Mede o Whisper nativo (whisper.cpp) nas falas desta pasta: erro de palavras e tempo.
uso: python3 bench.py large-v3-q5_0,large-v3-turbo-q8_0 8 [--prompt "..." -bs 1 -bo 1]
"""
import subprocess, re, sys, glob, os
HERE=os.path.dirname(os.path.abspath(__file__))
M=os.path.expanduser("~/tools/models/whisper"); CLI=os.path.expanduser("~/tools/whisper.cpp/build/bin/whisper-cli")
texts=dict(l.strip().split("|",1) for l in open(os.path.join(HERE,"textos.txt")))
def norm(s): s=s.lower(); s=re.sub(r"[^\w\s]"," ",s); return s.split()
def wer(r,h):
    d=list(range(len(h)+1))
    for i,a in enumerate(r,1):
        p,d[0]=d[0],i
        for j,b in enumerate(h,1): p,d[j]=d[j],min(d[j]+1,d[j-1]+1,p+(a!=b))
    return d[-1]/len(r)
models=sys.argv[1].split(","); threads=sys.argv[2]; extra=sys.argv[3:]
for m in models:
    errs=[];times=[];bad=[]
    for f in sorted(glob.glob(os.path.join(HERE,"*.wav"))):
        id=os.path.basename(f).split("-")[0]
        p=subprocess.run([CLI,"-m",f"{M}/ggml-{m}.bin","-l","pt","-t",threads,"-nt","-f",f]+extra,capture_output=True,text=True)
        out=p.stdout.strip(); t=re.search(r"total time =\s*([\d.]+)",p.stderr); l=re.search(r"load time =\s*([\d.]+)",p.stderr)
        times.append((float(t[1])-float(l[1]))/1000); w=wer(norm(texts[id]),norm(out)); errs.append(w)
        if w>0: bad.append(f"{os.path.basename(f)}: {out}")
    print(f"== {m} t={threads}: WER {100*sum(errs)/len(errs):.1f}%  frases perfeitas {sum(e==0 for e in errs)}/{len(errs)}  tempo médio {sum(times)/len(times):.2f}s  máx {max(times):.2f}s")
    for b in bad: print("   ",b)
