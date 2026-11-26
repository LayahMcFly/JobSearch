"""Makes the sample resumes used by folio/tests/import.test.cjs. Fictional person, fictional employers.
Run:  python3 folio/tests/fixtures/make_fixtures.py   (needs: pip install reportlab python-docx)"""
import os
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import LETTER
from docx import Document
from docx.shared import Pt

HERE = os.path.dirname(os.path.abspath(__file__))
CONTACT = ["Valdosta, GA", "jordan.ellis@example-mail.com", "(229) 555-0147", "jordanellis.com", "linkedin.com/in/jordan-ellis-writer"]
SUMMARY = ["Content strategist with eight years of experience writing B2B articles, guides and brand voice",
           "standards for software and finance companies."]
JOBS = [
  ("Senior Content Strategist", "Northwind Software, Remote", "Jan 2021 - Present",
   ["Led a six-person freelance team that published 120 articles a year",
    ["Wrote a brand voice guide adopted by sales, support and product teams across two", "business units"],
    "Grew organic search traffic 84% in 18 months"]),
  ("Freelance Writer", "Self-employed", "Mar 2016 - Dec 2020",
   ["Wrote 300+ SEO articles for 25 B2B clients", "Built editorial calendars and style guides for three agencies"]),
  ("Content Writer", "Brightline Media, Atlanta, GA", "Jun 2014 - Feb 2016",
   ["Produced four articles a week for finance clients"]),
]
EDU = ("B.A. in English", "University of Georgia", "2010 - 2014")
SKILLS = ["SEO", "Content strategy", "Editing", "Brand voice", "Ahrefs", "WordPress", "Google Analytics"]

def classic_pdf():
    c = canvas.Canvas(os.path.join(HERE, "resume-classic.pdf"), pagesize=LETTER); W, H = LETTER; y = H - 60
    c.setFont("Helvetica-Bold", 22); c.drawCentredString(W / 2, y, "JORDAN ELLIS"); y -= 18
    c.setFont("Helvetica", 10); c.drawCentredString(W / 2, y, "Content Strategist and SEO Writer"); y -= 14
    c.drawCentredString(W / 2, y, "  |  ".join(CONTACT[:3])); y -= 13; c.drawCentredString(W / 2, y, "  |  ".join(CONTACT[3:])); y -= 26
    def head(t):
        nonlocal y; c.setFont("Helvetica-Bold", 11); c.drawString(50, y, t); c.line(50, y - 3, W - 50, y - 3); y -= 18; c.setFont("Helvetica", 10)
    head("SUMMARY")
    for l in SUMMARY: c.drawString(50, y, l); y -= 13
    y -= 10; head("EXPERIENCE")
    for role, co, dates, bl in JOBS:
        c.setFont("Helvetica-Bold", 10); c.drawString(50, y, role + " | " + co); c.setFont("Helvetica", 10); c.drawRightString(W - 50, y, dates.replace("-", "–")); y -= 14
        for b in bl:
            lines = b if isinstance(b, list) else [b]
            c.drawString(58, y, "•"); c.drawString(70, y, lines[0]); y -= 13
            for extra in lines[1:]: c.drawString(70, y, extra); y -= 13
        y -= 8
    head("EDUCATION"); c.drawString(50, y, EDU[0] + ", " + EDU[1]); c.drawRightString(W - 50, y, EDU[2].replace("-", "–")); y -= 24
    head("SKILLS"); c.drawString(50, y, ", ".join(SKILLS)); y -= 24
    head("CERTIFICATIONS"); c.drawString(50, y, "HubSpot Content Marketing (2019)"); y -= 14
    c.save()

def sidebar_pdf():
    c = canvas.Canvas(os.path.join(HERE, "resume-sidebar.pdf"), pagesize=LETTER); W, H = LETTER
    LX, RX = 40, 215; y = H - 70
    c.setFont("Helvetica-Bold", 24); c.drawString(RX, y, "Jordan Ellis"); y -= 20
    c.setFont("Helvetica", 11); c.drawString(RX, y, "Content Strategist and SEO Writer"); y -= 34
    ly = H - 150
    def lhead(t):
        nonlocal ly; ly -= 10; c.setFont("Helvetica-Bold", 10); c.drawString(LX, ly, t); ly -= 16; c.setFont("Helvetica", 9)
    c.setFont("Helvetica-Bold", 10); c.drawString(LX, ly, "CONTACT"); ly -= 16; c.setFont("Helvetica", 9)
    for l in CONTACT: c.drawString(LX, ly, l); ly -= 14
    lhead("SKILLS")
    for s in SKILLS: c.drawString(LX, ly, s); ly -= 14
    lhead("EDUCATION"); c.drawString(LX, ly, EDU[0]); ly -= 13; c.drawString(LX, ly, "University of"); ly -= 13; c.drawString(LX, ly, "Georgia"); ly -= 13; c.drawString(LX, ly, EDU[2].replace("-", "–"))
    def rhead(t):
        nonlocal y; c.setFont("Helvetica-Bold", 12); c.drawString(RX, y, t); y -= 18; c.setFont("Helvetica", 10)
    rhead("PROFILE")
    for l in ["Content strategist with eight years of experience writing", "B2B articles, guides and brand voice standards for", "software and finance companies."]: c.drawString(RX, y, l); y -= 13
    y -= 14; rhead("WORK EXPERIENCE")
    for role, co, dates, bl in JOBS:
        c.setFont("Helvetica-Bold", 10); c.drawString(RX, y, role); y -= 13; c.setFont("Helvetica", 10); c.drawString(RX, y, co); y -= 13
        c.setFont("Helvetica-Oblique", 9); c.drawString(RX, y, dates.replace("-", "–")); y -= 15; c.setFont("Helvetica", 10)
        for b in bl:
            lines = b if isinstance(b, list) else [b]
            first = lines[0]; cut = first.rfind(" ", 0, 62) if len(first) > 62 else -1
            c.drawString(RX, y, "\u2022"); c.drawString(RX + 12, y, first if cut < 0 else first[:cut]); y -= 13
            rest = "" if cut < 0 else first[cut + 1:].strip()
            for extra in ([rest] if rest else []) + lines[1:]: c.drawString(RX + 12, y, extra); y -= 13
        y -= 10
    c.save()

def modern_docx():
    d = Document(); st = d.styles["Normal"]; st.font.name = "Calibri"; st.font.size = Pt(10.5)
    p = d.add_paragraph(); r = p.add_run("Jordan Ellis"); r.bold = True; r.font.size = Pt(20)
    d.add_paragraph("Content Strategist and SEO Writer")
    d.add_paragraph("  |  ".join(CONTACT))
    d.add_paragraph("Summary").runs[0].bold = True
    d.add_paragraph(" ".join(SUMMARY))
    d.add_paragraph("Experience").runs[0].bold = True
    for role, co, dates, bl in JOBS:
        p = d.add_paragraph(); r = p.add_run(role + ", " + co); r.bold = True; p.add_run("\t" + dates.replace("-", "–"))
        for b in bl: d.add_paragraph(" ".join(b) if isinstance(b, list) else b, style="List Bullet")
    d.add_paragraph("Education").runs[0].bold = True
    t = d.add_table(rows=1, cols=2); t.rows[0].cells[0].text = EDU[0] + ", " + EDU[1]; t.rows[0].cells[1].text = EDU[2].replace("-", "–")
    d.add_paragraph("Skills").runs[0].bold = True
    d.add_paragraph(", ".join(SKILLS))
    d.save(os.path.join(HERE, "resume-modern.docx"))

def text_files():
    top = ["Jordan Ellis", "Content Strategist and SEO Writer", "  |  ".join(CONTACT), ""]
    out = top + ["SUMMARY"] + SUMMARY + ["", "EXPERIENCE"]
    for role, co, dates, bl in JOBS:
        out.append(role + " | " + co + "    " + dates.replace("-", "–"))
        for b in bl: out.append("• " + (" ".join(b) if isinstance(b, list) else b))
        out.append("")
    out += ["EDUCATION", EDU[0] + ", " + EDU[1] + "    " + EDU[2].replace("-", "–"), "", "SKILLS", ", ".join(SKILLS), "", "CERTIFICATIONS", "HubSpot Content Marketing (2019)", "", "LANGUAGES", "English, Spanish"]
    open(os.path.join(HERE, "resume-classic.txt"), "w", encoding="utf-8").write("\n".join(out) + "\n")
    # an older version: two of the same jobs with fewer bullets, one extra early job, a different skill, wording of the degree differs
    old = ["JORDAN ELLIS", "Content Writer", "Valdosta, GA  ·  jordan.ellis@example-mail.com  ·  229.555.0147", "", "Profile", "Writer with five years of experience in finance and technology content.", "",
           "Work History", "Freelance Writer, Self-employed", "March 2016 to Present", "- Wrote 300+ SEO articles for 25 B2B clients", "- Managed client relationships and invoicing", "",
           "Content Writer at Brightline Media", "June 2014 to February 2016", "- Produced four articles a week for finance clients", "- Edited weekly newsletter copy", "",
           "Editorial Intern, Peachtree Weekly", "May 2013 to Aug 2013", "- Fact-checked features and proofread print issues", "",
           "Education", "University of Georgia", "Bachelor of Arts, English", "2014", "", "Skills", "Copywriting, SEO, Editing"]
    open(os.path.join(HERE, "resume-older.txt"), "w", encoding="utf-8").write("\n".join(old) + "\n")

def blank_pdf():
    c = canvas.Canvas(os.path.join(HERE, "scan-no-text.pdf"), pagesize=LETTER); c.rect(72, 600, 300, 80, fill=1); c.save()

if __name__ == "__main__":
    classic_pdf(); sidebar_pdf(); modern_docx(); text_files(); blank_pdf(); print("fixtures written to", HERE)
