const puppeteer = require('puppeteer');
const axios = require('axios');
const cheerio = require('cheerio');
const { PDFDocument } = require('pdf-lib');

const openaiApiKey = process.env.OPENAI_API_KEY;

async function generateBullets(mode, existingBullets, keywords, context, wordLimit) {
    const basePrompt = `
You are a resume-bullet optimizer. Insert EVERY keyword somewhere in the bullet set, keep all original metrics, and obey technology logic.

────────────────────────────
SECTION ❶ — HARD RULES
────────────────────────────
R-1  Metrics stay exactly as written (no edits, no new numbers).  
R-2  Every bullet starts with a UNIQUE, strong action verb.  
R-3  ≤ ${wordLimit} words per bullet.  
R-4  Prefix: ONLY the *final* bullets start with '>>'; drafts do NOT.  
R-5  Anti-Overstuffing: ≤ 3 keywords per bullet.  
R-6  **No Grocery Lists:** never chain >2 keywords with commas; weave them naturally.  
R-7  Tech validity: never mix incompatible ecosystems (see map).  
R-8  Remove a tech term ONLY if it is irrelevant *and* not a keyword.  

────────────────────────────
SECTION ❷ — TECHNOLOGY DOMAIN MAP (abridged)
────────────────────────────
• Java → Spring / Hibernate / Maven / JUnit  
• Python → Django / Flask / NumPy / Pandas  
• JavaScript → Node.js / React / Angular / Express  
• TypeScript → Angular / React / Next.js  
• C# → .NET / ASP.NET / Entity Framework  
• Clouds, mobile, CRM: AWS ≠ Azure ≠ GCP, iOS ≠ Android, etc.  

────────────────────────────
SECTION ❸ — ITERATIVE WORKFLOW
────────────────────────────
Step-0  **Keyword Checklist**: ☐ keyword1, ☐ keyword2, … ☐ keywordN  

LOOP until every box is ✓:  
  Step-1  Scan current bullets; mark ✓ for any keyword found (exact or synonym).  
  Step-2  For each ☐ unchecked keyword, create or revise bullets:  
          • Preserve metrics (R-1) and obey R-2…R-8.  
          • Draft bullets here MUST NOT start with '>>'.  
  Step-3  Show updated bullets *and* the updated checklist.  
  Step-4  Return to Step-1.  

────────────────────────────
SECTION ❹ — FINAL OUTPUT FORMAT (after loop finishes)
────────────────────────────
CRITICAL OUTPUT RULES:
1. The FINAL BULLETS section MUST start with the exact line "FINAL BULLETS:"
2. Each bullet MUST be on its own line
3. Each bullet MUST start with ">>" (no space before, one space after)
4. No empty lines between bullets
5. No additional formatting or prefixes

Example format:
FINAL BULLETS:
>>First bullet with achievement
>>Second bullet with different achievement
>>Third bullet showing another win

CHECKLIST COMPLETE:  
✓ keyword1, ✓ keyword2, … ✓ keywordN
────────────────────────────────────────────────────────
INPUT BULLETS:
${(existingBullets || []).join('\n')}

PROVIDED KEYWORDS:
${keywords.join(', ')}

TASK MODE:
${mode === 'tailor'
  ? `Rewrite the ${existingBullets.length} bullets above without changing their count.`
  : `Generate ${existingBullets.length} bullets that fit the context: ${context || '(none)'}.`}`;

    const keywordsSection = ''; 
    const bulletCount = (existingBullets || []).length;

    const taskPrompt = mode === 'tailor'
        ? `${basePrompt}

TASK: Substantially rewrite and enhance the bullets so **ALL PROVIDED KEYWORDS ARE COVERED** across exactly ${bulletCount} bullets.  
CRITICAL: Preserve every original metric and achievement.  
Ensure all technology combinations are valid, respect R-1…R-8, and honor the Anti-Overstuffing + No-Grocery-Lists rules.

REMEMBER: Your output MUST follow the exact format shown in SECTION ❹.`
        : `${basePrompt}

TASK: Generate **${bulletCount} achievement-focused bullets** ${context || ''}.  
Use varied action verbs, concrete metrics, and **ENSURE EVERY KEYWORD APPEARS AT LEAST ONCE**.  
All bullets must respect R-1…R-8, Anti-Overstuffing, and No-Grocery-Lists.

REMEMBER: Your output MUST follow the exact format shown in SECTION ❹.`;

    const verificationInstructions = `

VERIFICATION & COMPLETION INSTRUCTIONS
1. After drafting bullets, produce the Keyword Checklist and mark ✓ / ☐.  
2. If any ☐ remain, thoughtfully revise until EVERY keyword is ✓.  
3. Show reasoning lines prefixed with 'THOUGHT:' explaining changes.
4. Once all keywords are ✓, output the FINAL BULLETS section:
   - Start with the exact line "FINAL BULLETS:"
   - Each bullet on its own line starting with ">>" (no space before, one space after)
   - No empty lines between bullets
   - No additional formatting or prefixes
5. End with CHECKLIST COMPLETE showing all keywords are ✓`;

    const finalPrompt = `${taskPrompt}${verificationInstructions}`;

    try {
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: "gpt-4.1-mini",
                messages: [
                    {
                        role: "system",
                        content: "You are a specialized resume-bullet optimizer with deep knowledge of technology relationships. NEVER output an invalid tech combination. Follow all rules, especially Anti-Overstuffing and No-Grocery-Lists."
                    },
                    {
                        role: "user",
                        content: finalPrompt
                    }
                ],
                temperature: 0.4,
                max_tokens: 4096,
                top_p: 1
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${openaiApiKey}`
                }
            }
        );

        const content = response.data.choices[0].message.content;
        console.log('Raw API response content:', content);
        
        const lines = content.split('\n');
        
        // Find where the final bullets section starts
        const finalBulletsIndex = lines.findIndex(line => 
            line.trim().toUpperCase().includes('FINAL BULLETS'));
        
        if (finalBulletsIndex === -1) {
            console.error('No FINAL BULLETS section found in response');
            return [];
        }
        
        // Extract bullets after the FINAL BULLETS marker
        const bullets = lines
            .slice(finalBulletsIndex + 1)  // Start after "FINAL BULLETS:"
            .filter(line => line.trim().startsWith('>>'))  // Only get lines starting with '>>'
            .map(bullet => {
                // Clean up the bullet point
                let cleaned = bullet.trim();
                // Remove the '>>' prefix and any leading/trailing whitespace
                cleaned = cleaned.replace(/^>>\s*/, '');
                // Remove any other common bullet point markers
                cleaned = cleaned.replace(/^(?:[>\-–—•*]\s*)+/, '');
                // Remove any numbering
                cleaned = cleaned.replace(/^\s*\(?\d+\)?[.\)]\s+/, '');
                cleaned = cleaned.replace(/^\s*\(?[A-Za-z]\)?[.\)]\s+/, '');
                // Remove any markdown formatting
                cleaned = cleaned.replace(/\*\*/g, '');
                // Remove any trailing parenthetical notes
                cleaned = cleaned.replace(/\s*\([^)]*\)$/, '');
                return cleaned.trim();
            })
            .filter(bullet => bullet.length > 0);  // Remove any empty bullets
            
        console.log('Processed bullets:', bullets);
        
        if (bullets.length === 0) {
            console.error('No valid bullets found in the response');
            console.log('Full response content for debugging:', content);
        }
        
        return bullets;
    } catch (error) {
        console.error('Error generating bullets:', error.response?.data || error.message);
        return [];
    }
}

async function updateResume(htmlContent, keywords, fullTailoring) {
    const $ = cheerio.load(htmlContent);
    const allBulletsToProcess = [];
    const ulElements = $('ul');
    const bulletListMap = new Map();
    const ulElementMap = new Map();
    
    ulElements.each((index, ul) => {
        const currentUl = $(ul);
        const liElements = currentUl.children('li');
        const bulletTexts = liElements.map((_, li) => $(li).text().trim()).get();
        bulletListMap.set(currentUl, bulletTexts);
        allBulletsToProcess.push(...bulletTexts);
        ulElementMap.set(currentUl, bulletTexts.length);
    });
    
    let processedCount = 0;
    let firstUlElement = null;
    
    const processedBullets = await generateBullets(
        fullTailoring ? 'tailor' : 'generate',
        allBulletsToProcess,
        keywords,
        'for experience section',
        12
    );
    
    let currentIndex = 0;
    
    for (const [ulElement, originalBullets] of bulletListMap) {
        if (!firstUlElement) firstUlElement = ulElement;
        
        const originalCount = ulElementMap.get(ulElement);
        const endIndex = currentIndex + originalCount;
        const bulletsForCurrentUl = processedBullets.slice(currentIndex, endIndex);
        
        const currentLiElements = ulElement.children('li');
        
        currentLiElements.each((index, li) => {
            if (index < bulletsForCurrentUl.length) {
                $(li).text(bulletsForCurrentUl[index]);
            }
        });
        
        if (currentLiElements.length > bulletsForCurrentUl.length) {
            currentLiElements.slice(bulletsForCurrentUl.length).remove();
        }
        
        if (bulletsForCurrentUl.length > currentLiElements.length) {
            for (let i = currentLiElements.length; i < bulletsForCurrentUl.length; i++) {
                ulElement.append($('<li>').text(bulletsForCurrentUl[i]));
            }
        }
        
        currentIndex = endIndex;
    }
    
    const finalHtml = $.html();
    return finalHtml;
}

async function checkPageHeight(page) {
    return await page.evaluate(() => {
        const body = document.body;
        const html = document.documentElement;
        return Math.max(
            body.scrollHeight,
            body.offsetHeight,
            html.clientHeight,
            html.scrollHeight,
            html.offsetHeight
        );
    });
}

async function convertHtmlToPdf(htmlContent) {
    const browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    const customCSS = `
        @page {
            size: Letter;
            margin: 0.25in;
        }
        body {
            margin: 0;
            padding: 0;
        }
    `;
    await page.setContent(htmlContent);
    await page.evaluate((css) => {
        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
    }, customCSS);
    const height = await checkPageHeight(page);
    const MAX_HEIGHT = 1056;
    const pdfBuffer = await page.pdf({
        format: 'Letter',
        printBackground: true,
        preferCSSPageSize: true,
        margin: {
            top: '0.25in',
            right: '0.25in',
            bottom: '0.25in',
            left: '0.25in'
        }
    });
    await browser.close();
    // Determine actual PDF page count
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const pageCount = pdfDoc.getPageCount();
    return { pdfBuffer, height, exceedsOnePage: height > MAX_HEIGHT, pageCount };
}

// Helper to remove one bullet point from the resume HTML
function removeOneBullet(htmlContent) {
    const $ = cheerio.load(htmlContent);
    let maxCount = 0;
    let targetUl = null;
    $('ul').each((i, ul) => {
        const count = $(ul).children('li').length;
        if (count > maxCount) {
            maxCount = count;
            targetUl = $(ul);
        }
    });
    if (targetUl && maxCount > 0) {
        targetUl.children('li').last().remove();
    }
    return $.html();
}

async function customizeResume(req, res) {
    try {
        const { htmlContent, keywords, fullTailoring } = req.body;
        if (!htmlContent || !Array.isArray(keywords)) {
            return res.status(400).send('Invalid input: HTML content and keywords array are required');
        }
        console.log('Received keywords:', keywords);
        console.log('Full tailoring enabled:', fullTailoring);
        if (htmlContent.length < 100) {
            return res.status(400).send('Invalid HTML content: Content too short');
        }
        // Generate tailored HTML and iteratively trim bullets until the PDF is one page
        let updatedHtmlContent = await updateResume(htmlContent, keywords, fullTailoring);
        let { pdfBuffer, pageCount } = await convertHtmlToPdf(updatedHtmlContent);
        if (pageCount === 2) {
            console.log('Detected exactly 2-page resume; initiating bullet removal.');
        }
        while (pageCount > 1) {
            console.log(`Resume is ${pageCount} pages; removing a bullet point.`);
            updatedHtmlContent = removeOneBullet(updatedHtmlContent);
            const result = await convertHtmlToPdf(updatedHtmlContent);
            pdfBuffer = result.pdfBuffer;
            pageCount = result.pageCount;
        }
        res.contentType('application/pdf');
        res.set('Content-Disposition', 'attachment; filename=resume.pdf');
        res.send(Buffer.from(pdfBuffer));
    } catch (error) {
        res.status(500).send('Error processing resume: ' + error.message);
    }
}

module.exports = { customizeResume };
