# Turns the parsed Living Cookbook JSON into the app's seed file (app/data/seed-recipes.json).
# Code: © Corey J Ruff
import json, uuid, sys
src, dst = sys.argv[1], sys.argv[2]
REVIEW = {'Salmon Cream Cheese Dip', 'Swirled Cranberry Cheesecake', "Neely's BBQ Pasta Salad", 'Mini Reubens'}
FIXES = {'Mini Reubens': [
    {'amount': '1', 'unit': '', 'item': '(1 pound) loaf cocktail rye bread'},
    {'amount': '1', 'unit': 'cup', 'item': 'thousand island dressing'},
    {'amount': '1 ½', 'unit': 'lbs', 'item': 'deli sliced corned beef'},
    {'amount': '1', 'unit': '', 'item': '(16 ounce) jar sauerkraut, rinsed and well drained'},
    {'amount': '1', 'unit': 'lb', 'item': 'sliced Swiss cheese'}]}
now = '2020-06-24T16:13:00.000Z'
out = []
for r in json.load(open(src)):
    notes = list(r.get('notes', []))
    y = [n for n in notes if n.startswith('Yield:')]
    for n in y: notes.remove(n)
    out.append({
        'id': str(uuid.uuid5(uuid.NAMESPACE_URL, 'livingcookbook/%d/%s' % (r['id'], r['title']))),
        'title': r['title'], 'description': r.get('description', ''),
        'servings': r.get('servings') or (y[0][6:].strip() if y else ''), 'prepTime': '', 'cookTime': '',
        'ingredients': FIXES.get(r['title'], r['ingredients']), 'steps': r['steps'], 'notes': '\n'.join(notes),
        'tags': [], 'favorite': False, 'rating': 0, 'source': r.get('original_source', ''), 'sourceUrl': '',
        'origin': 'Living Cookbook', 'images': [], 'addedBy': '',
        'needsReview': r['title'] in REVIEW and r['title'] not in FIXES,
        'createdAt': now, 'updatedAt': now, 'deleted': False})
json.dump(out, open(dst, 'w'), ensure_ascii=False, indent=1)
print(len(out), 'recipes,', sum(r['needsReview'] for r in out), 'flagged for review')
