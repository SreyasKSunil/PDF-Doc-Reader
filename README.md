# PDF-Doc-Reader
Read Aloud Webapp (PDF, DOCX)

What this does
- Loads a PDF or DOCX file in your browser
- Shows the extracted text as tappable lines
- Reads the text using the device voice (Web Speech API)
- Speed control
- Play, Pause (resumes), Stop
- Tap any line to start reading from that line

Supported
- PDF: text-based PDFs work best
- DOCX: supported
- DOC (old Word format): not supported in this client-only version

Privacy
- Runs fully in the browser
- No uploads, no server

How to run locally
- Open index.html in a browser
- For best results, use a local server:
  python3 -m http.server 8000
  Then open http://localhost:8000

How to host on GitHub Pages
1. Create a new GitHub repo and upload these files to the root
2. Repo settings -> Pages
3. Source: Deploy from a branch
4. Branch: main, folder: / (root)
5. Open the GitHub Pages URL shown there

Notes
- iPhone Safari requires a tap to start speech. Use the Play button or tap a line.
- Some PDFs have no selectable text. Those will not read well.
