import pdfplumber, re, json, sys
sys.path.insert(0, __import__('os').path.dirname(__file__))
from lines import page_lines

AMT = re.compile(r'^[\d½¼¾⅓⅔⅛⅜⅝⅞.\-/]+$')
UNITS = {'tsp','tsps','teaspoon','teaspoons','tbsp','tbs','tbl','tbls','tablespoon','tablespoons','t','c',
 'cup','cups','oz','ounce','ounces','lb','lbs','pound','pounds','pinch','dash','dashes','can','cans','clove','cloves',
 'pkg','package','packages','pkgs','qt','quart','quarts','pt','pint','pints','gal','gallon','stick','sticks','slice','slices',
 'jar','jars','bottle','bottles','box','boxes','bag','bags','bunch','head','heads','sprig','sprigs','envelope','envelopes',
 'g','kg','ml','l','liter','liters','fl','small','medium','large','whole','container','containers','loaf'}
SPLIT_X = 295
STANDALONE = {'salt','pepper','soy','poultry','pinch','dash','fresh','butter-flavored','cayenne','kosher','sharp'}
DANGLE = {'black','white','thinly','finely','freshly','ground','and','or','to','of','the','a','an','with','in','for','into','plus','about','such'}

def txt(ws): return ' '.join(w['text'] for w in ws).strip()
def bold(ws): return all('F3' in w['fontname'] for w in ws)
def ital(ws): return all('F4' in w['fontname'] for w in ws if w['text'].strip())

def norm_amount(a):
    return re.sub(r'(\d)([½¼¾⅓⅔⅛⅜⅝⅞])', r'\1 \2', a)

def parse_ing(s):
    toks = s.split()
    amt = []
    while toks and (AMT.match(toks[0]) or (amt and toks[0] in ('or','to') and len(toks)>1 and AMT.match(toks[1]))):
        amt.append(toks.pop(0))
    unit = ''
    if amt and toks and toks[0].lower().rstrip('.') in UNITS and len(toks) > 1:
        unit = toks.pop(0)
    return {'amount': norm_amount(' '.join(amt)), 'unit': unit, 'item': ' '.join(toks)}

def parse_page(pg, n):
    L = page_lines(pg)
    flags = []
    big = [l for l in L if l['w'][0]['size'] > 14]
    title_line = big[-1]
    title = ' '.join(txt(l['w']) for l in big)
    rest = [l for l in L if l['mid'] > title_line['mid']]
    # cut at Nutrition Facts
    for i, l in enumerate(rest):
        if txt(l['w']).startswith('Nutrition Facts'):
            rest = rest[:i]; break
    desc = []
    i = 0
    while i < len(rest) and ital(rest[i]['w']):
        desc.append(txt(rest[i]['w'])); i += 1
    # ingredient block: contiguous lines spaced <= 14
    ing_lines = []
    if i < len(rest):
        ing_lines.append(rest[i]); i += 1
        while i < len(rest) and rest[i]['mid'] - rest[i-1]['mid'] <= 14.5:
            ing_lines.append(rest[i]); i += 1
    # sanity: if "ingredient block" looks like steps (starts with number then word at ~67 and line spacing ~15), it's fine anyway
    cols = [[], []]
    tail = []
    for l in ing_lines:
        left = [w for w in l['w'] if w['x0'] < SPLIT_X]
        for k in range(2, len(left) - 1):
            w, nx = left[k], left[k + 1]
            if (w['x0'] > 130 and AMT.match(w['text']) and
                    (nx['text'].lower().rstrip('.') in UNITS or nx['text'].startswith('(')) and
                    left[k - 1]['text'].lower() not in ('or', 'and', 'plus', 'to')):
                tail.append({'raw': txt(left[k:]), 'x1': left[-1]['x1']})
                left = left[:k]
                break
        right = [w for w in l['w'] if w['x0'] >= SPLIT_X]
        for c, ws in ((0, left), (1, right)):
            if not ws: continue
            s = txt(ws)
            item_x = ws[0]['x0']
            prev = cols[c][-1] if cols[c] else None
            if bold(ws) or (s.endswith(':') and len(s) < 30) or s.lower() in ('ingrediants', 'ingredients'):
                h = s.rstrip(':')
                if h.lower() not in ('ingrediants', 'ingredients'): cols[c].append({'heading': h})
                continue
            starts_amt = AMT.match(ws[0]['text'])
            limit = 292 if c == 0 else 560
            if prev and 'raw' in prev and not starts_amt and (
                    prev['raw'].count('(') > prev['raw'].count(')') or
                    prev['x1'] + (ws[0]['x1'] - ws[0]['x0']) + 4 > limit or
                    prev['raw'].endswith(',') or prev['raw'].split()[-1].lower() in DANGLE or
                    (s[0].islower() and AMT.match(prev['raw'].split()[0]) and 'taste' not in prev['raw']
                     and s.split()[0].lower() not in STANDALONE)):
                prev['raw'] += ' ' + s; prev['x1'] = ws[-1]['x1']; continue
            cols[c].append({'raw': s, 'x1': ws[-1]['x1']})
    cols[1].extend(tail)
    ingredients = []
    for c in cols:
        for e in c:
            if 'heading' in e: ingredients.append({'section': e['heading']})
            else:
                d = parse_ing(e['raw']); ingredients.append(d)
    # steps
    steps, notes, servings, cur, src = [], [], None, None, None
    section = None; mode = 'steps'; last_mid = None
    for l in rest[i:]:
        ws = l['w']; s_ = txt(ws)
        gap = (l['mid'] - last_mid) if last_mid else 99
        last_mid = l['mid']
        if not s_: continue
        m = re.match(r'^Servings:\s*(.+)$', s_)
        if m: servings = m.group(1); mode = 'notes'; cur = None; continue
        m = re.match(r'^Source:\s*(.+)$', s_)
        if m: src = m.group(1); continue
        if bold(ws):
            if s_.lower() in ('source', 'notes', 'note', 'tips'): mode = 'notes'; cur = None; continue
            section = s_; cur = None; mode = 'steps'; continue
        if mode == 'notes':
            notes.append(s_); continue
        if re.fullmatch(r'\d+', ws[0]['text']) and ws[0]['x0'] < 62 and len(ws) > 1 and 62 < ws[1]['x0'] < 80:
            body = txt(ws[1:])
            if body.lower().startswith('nutritional information'): cur = None; continue
            cur = {'text': body, 'numbered': True}
            if section: cur['section'] = section
            steps.append(cur); continue
        if cur is not None and (ws[0]['x0'] > 62 or (not cur.get('numbered') and gap <= 14.5)):
            cur['text'] += ' ' + s_; continue
        cur = {'text': s_}
        if section: cur['section'] = section
        steps.append(cur)
    for st in steps: st.pop('numbered', None)
    if not ingredients: flags.append('no ingredients found')
    if not steps: flags.append('no steps found')
    for d in ingredients:
        if 'item' in d and not d['amount'] and not d['item']: flags.append('empty ingredient')
    r = {'id': n, 'title': title}
    if desc: r['description'] = ' '.join(desc)
    if servings: r['servings'] = servings
    r['ingredients'] = ingredients
    r['steps'] = steps
    if notes: r['notes'] = notes
    if src: r['original_source'] = src
    r['source'] = 'Living Cookbook (2020 export)'
    return r, flags

if __name__ == '__main__':
    out, allflags = [], {}
    with pdfplumber.open(sys.argv[1]) as p:
        for n, pg in enumerate(p.pages, 1):
            r, f = parse_page(pg, n)
            out.append(r)
            if f: allflags[r['title']] = f
    json.dump(out, open(sys.argv[2], 'w'), ensure_ascii=False, indent=2)
    print(len(out), 'recipes;', 'flags:', json.dumps(allflags, indent=1))
