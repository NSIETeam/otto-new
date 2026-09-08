"""Generate bundled public-research demo; --check verifies it still matches the source CSV."""
import csv,json,pathlib,sys
root=pathlib.Path(__file__).resolve().parents[3]
source=root/'docs/data/beikong-hongchuang'
output=root/'packages/desktop/src/renderer/starMap'
with (source/'enterprises.csv').open(encoding='utf-8-sig',newline='') as f: rows=list(csv.DictReader(f))
nodes=[]
for row in rows:
 if row['includeInDemo']!='true' or row['entityRole']!='enterprise':continue
 node={k:row[k] for k in ['organizationName','displayName','summary','website','publicContact','primaryIndustryCode','primaryIndustryName','industryClassificationBasis','officeAddress','addressType','parkRelationStatus','parkEvidence','parkSourceUrl','profileSourceUrl','retrievedAt','notes']}
 for k in ['industryTags','productsServices','capabilities','cooperationNeeds']:node[k]=json.loads(row[k])
 node.update(organizationId='demo:'+row['seedId'],isPublic=True,industryConfirmedByCompany=False,updatedAt=None)
 nodes.append(node)
assert len(nodes)==17 and len({n['organizationId'] for n in nodes})==17
groups={}
for n in nodes:groups.setdefault(n['primaryIndustryCode'],[]).append(n['organizationId'])
data=dict(parkId='demo:bhc-public-2026-09-08',parkName='北控宏创科技园',currentOrganizationId='',generatedAt='2026-09-08T00:00:00.000Z',dataSource='demo',relationType='same_industry',taxonomyVersion='park-industry-v1',nodes=nodes,edges=[],industryGroups=[dict(code=code,name=next(n['primaryIndustryName'] for n in nodes if n['primaryIndustryCode']==code),memberOrganizationIds=sorted(ids)) for code,ids in sorted(groups.items())],unclassifiedNodeIds=[],relationshipCount=sum(len(ids)*(len(ids)-1)//2 for ids in groups.values()))
assert data['relationshipCount']==11
outputs={'beikongDemo.json':json.dumps(data,ensure_ascii=False,indent=2)+'\n','industryTaxonomy.json':(root/'packages/server/src/modules/park_services/enterpriseIndustryTaxonomy.json').read_text()}
for name,content in outputs.items():
 target=output/name
 if '--check' in sys.argv:assert target.read_text()==content, str(target)+' is stale'
 else:target.parent.mkdir(parents=True,exist_ok=True);target.write_text(content)
print('Demo verified: 17 enterprises, 10 groups, 11 relationships; no production accounts created.')
