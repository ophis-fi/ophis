"""Read the three official full exports. Only public names and listing references are indexed."""
import hashlib
import json
import sys
import urllib.request
import xml.etree.ElementTree as ET

SOURCES = {
    "eu": "https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw",
    "un": "https://scsanctions.un.org/resources/xml/en/consolidated.xml",
    "ofac": "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML",
}


def parts(node, fields):
    return " ".join(filter(None, (node.findtext(field) for field in fields)))


def records(code, root):
    if code == "eu" and root.tag == "export":
        for item in root.findall("sanctionEntity"):
            yield item.get("euReferenceNumber") or item.get("logicalId"), [
                node.get("wholeName") or " ".join(filter(None, (node.get(k) for k in ("firstName", "middleName", "lastName"))))
                for node in item.findall("nameAlias")]
    elif code == "un" and root.tag == "CONSOLIDATED_LIST":
        for item in root.findall("./INDIVIDUALS/INDIVIDUAL") + root.findall("./ENTITIES/ENTITY"):
            yield item.findtext("REFERENCE_NUMBER"), [
                parts(item, ("FIRST_NAME", "SECOND_NAME", "THIRD_NAME", "FOURTH_NAME")),
                item.findtext("NAME_ORIGINAL_SCRIPT"),
                *(node.text for node in item.findall("./*/ALIAS_NAME"))]
    elif code == "ofac" and root.tag == "sdnList":
        entries = root.findall("sdnEntry")
        if len(entries) != int(root.findtext("publshInformation/Record_Count") or 0):
            raise ValueError("incomplete OFAC export")
        for item in entries:
            yield item.findtext("uid"), [parts(node, ("firstName", "lastName"))
                                         for node in [item, *item.findall("./akaList/aka")]]
    else:
        raise ValueError(f"unexpected {code} export")


def download(code, url):
    limit = 96 * 1024 * 1024
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Ophis-Name-Screening/1", "Cache-Control": "no-cache"}), timeout=60) as response:
        payload = response.read(limit + 1)
    if len(payload) > limit or b"<!DOCTYPE" in payload or b"<!ENTITY" in payload or b"\x00" in payload:
        raise ValueError(f"invalid {code} export")
    root = ET.fromstring(payload)
    for node in root.iter():
        node.tag = node.tag.split("}")[-1]
    rows = []
    count = 0
    for reference, aliases in records(code, root):
        aliases = list(dict.fromkeys(n.strip() for n in aliases if n and n.strip()))
        if not reference or not aliases:
            raise ValueError(f"missing {code} reference or name")
        count += 1
        rows.extend([code, reference, name] for name in aliases)
    # Reject partial or wrong downloads before publishing a replacement index.
    if count < {"eu": 1000, "un": 500, "ofac": 10000}[code]:
        raise ValueError(f"incomplete {code} export ({count} records)")
    return hashlib.sha256(payload).hexdigest(), rows


if __name__ == "__main__":
    hashes, names = {}, []
    for source, url in SOURCES.items():
        hashes[source], rows = download(source, url)
        names.extend(rows)
    json.dump({"lists": hashes, "names": names}, sys.stdout, ensure_ascii=False)
