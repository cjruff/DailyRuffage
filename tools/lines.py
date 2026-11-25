import pdfplumber, sys
def page_lines(pg):
    ws = pg.extract_words(extra_attrs=['size','fontname'], keep_blank_chars=False, x_tolerance=1.5)
    ws = [w for w in ws if 50 < w['top'] < 740]
    ws.sort(key=lambda w:(w['top'], w['x0']))
    lines=[]
    for w in ws:
        mid=(w['top']+w['bottom'])/2
        for L in lines:
            if abs(L['mid']-mid) < 4: L['w'].append(w); break
        else: lines.append({'mid':mid,'w':[w]})
    for L in lines: L['w'].sort(key=lambda w:w['x0'])
    lines.sort(key=lambda L:L['mid'])
    return lines
if __name__=='__main__':
    with pdfplumber.open(sys.argv[1]) as p:
        for i in map(int, sys.argv[2:]):
            for L in page_lines(p.pages[i]):
                print(i, round(L['mid']), ' '.join(f"{round(w['x0'])}:{w['text']}{'*' if 'F3' in w['fontname'] else ''}{'~' if 'F4' in w['fontname'] else ''}" for w in L['w'])[:200])
