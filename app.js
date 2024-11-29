const express = require('express');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const port = 3000;

const openaiApiKey = process.env.api_key; // Replace with your actual OpenAI API key

app.use(bodyParser.text({ type: 'text/html' }));
app.use(bodyParser.json({ limit: '50mb' }));

async function generateBulletPoints(keywords, context) {
    const prompt = `As an expert resume writer, your task is to create bullet points for a resume ${context}, with each bullet point limited to 15 words or less. Create enough bullet points to incorporate all provided keywords, with a maximum of five bullet points. It is crucial that ALL provided keywords are incorporated into the bullet points. Do not omit any keywords.

Before we proceed, let's ensure we're on the same page:
- What does it mean for a bullet point to be concise and not exceed 15 words?
- What are personal pronouns and why should they be avoided in this context?
- Can you provide an example of a strong action verb?

The bullet points should be tailored to the following keywords: ${keywords}.

For at least two of the bullet points, include numbers to quantify achievements. Despite limited experience, aim to make your bullet points impressive. Can you provide an example of how to do this?

You are also asked to structure the resume based on the STAR method. Can you explain what the STAR method is and how it provides a clear and engaging narrative of accomplishments?

Ensure that all keywords are incorporated in the bullet points and that they are relevant to the job role and industry. Prioritize the inclusion of all keywords over other considerations, while still maintaining coherence and relevance within the 15-word limit. Remember to apply the STAR method to your bullet points where possible.

After generating the bullet points, provide a checklist of all keywords and indicate which bullet point(s) each keyword appears in.

Please format your response as follows:
1. Provide any explanations or additional information.
2. List the bullet points, each on a new line, prefixed with '>>'.
3. After the bullet points, provide a checklist of all keywords and indicate which bullet point(s) each keyword appears in.

Example format:
[Any explanations or additional information]

>>First bullet point here
>>Second bullet point here
>>Third bullet point here

Keyword checklist:
- Keyword1: Appears in bullet points 1, 3
- Keyword2: Appears in bullet point 2`;

    try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: 'You are a professional resume writer.' },
                { role: 'user', content: prompt }
            ]
        }, {
            headers: {
                'Authorization': `Bearer ${openaiApiKey}`,
                'Content-Type': 'application/json'
            }
        });

        const content = response.data.choices[0].message.content.trim();
        const bulletPoints = content.match(/^\>\>(.+)$/gm).map(bp => bp.replace(/^>>\s*/, ''));
        return bulletPoints;
    } catch (error) {
        console.error('Error generating bullet points:', error);
        throw error;
    }
}

async function generateTailoredBulletPoints(existingBullets, keywords, context) {
    const prompt = `As an expert resume writer, enhance the following bullet points by incorporating these keywords: ${keywords} while maintaining their original meaning. Ensure that modifications to each bullet point are minimal, only adjusting slightly to incorporate the keywords.
    Each bullet point must:
    - Be prefixed with '>>'.
    - Contain no more than 13 words.
    - Preserve the core meaning with minimal changes.
    - Incorporate keywords naturally.
    - Follow the STAR method where applicable.
    
    Existing bullet points:
    ${existingBullets.join('\n')}
    
    Rules:
    1. **Prefix each bullet with '>>'.** This is mandatory.
    2. **Do not exceed 13 words per bullet.** Count words carefully.
    3. **Maintain the original meaning** of each bullet point with minimal modifications.
    4. **Incorporate keywords naturally** without forcing them.
    5. **Use the STAR method** when applicable.
    6. **Avoid significant changes** to the bullet points; only slight adjustments are allowed to include keywords.
    
    Please format your response strictly as bullet points prefixed with '>>', each having a maximum of 13 words. Do not include any additional text or explanations.`;

    try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: 'You are a professional resume writer.' },
                { role: 'user', content: prompt }
            ]
        }, {
            headers: {
                'Authorization': `Bearer ${openaiApiKey}`,
                'Content-Type': 'application/json'
            }
        });

        const content = response.data.choices[0].message.content.trim();
        return content.match(/^\>\>(.+)$/gm).map(bp => bp.replace(/^>>\s*/, ''));
    } catch (error) {
        console.error('Error generating tailored bullet points:', error);
        throw error;
    }
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

async function updateResumeSection($, sections, keywords, context, fullTailoring) {
    let previousFirstVerb = '';

    for (let i = 0; i < sections.length; i++) {
        const section = sections.eq(i);
        const bulletList = section.find('ul');

        if (bulletList.length > 0) {
            if (fullTailoring && bulletList.find('li').length > 0) {
                // Extract existing bullets and tailor them
                const existingBullets = bulletList.find('li')
                    .map((_, el) => $(el).text())
                    .get();
                    
                const tailoredPoints = await generateTailoredBulletPoints(
                    existingBullets,
                    keywords[i % keywords.length],
                    context
                );
                
                bulletList.empty();
                tailoredPoints.forEach(point => {
                    bulletList.append(`<li>${point}</li>`);
                });
            } else if (bulletList.find('li').length === 0) {
                // Original behavior for empty sections
                let bulletPoints = await generateBulletPoints(keywords[i % keywords.length], context);
                
                bulletPoints = shuffleArray(bulletPoints);

                while (bulletPoints[0].split(' ')[0].toLowerCase() === previousFirstVerb.toLowerCase()) {
                    bulletPoints = shuffleArray(bulletPoints);
                }

                previousFirstVerb = bulletPoints[0].split(' ')[0];

                bulletPoints.forEach(point => {
                    bulletList.append(`<li>${point}</li>`);
                });
            }
        }
    }
}

async function updateResume(htmlContent, keywords, fullTailoring) {
    const $ = cheerio.load(htmlContent);
    
    const keywordGroups = fullTailoring ? 
        Array(5).fill(keywords.join(', ')) : // Create multiple copies for different sections
        [keywords.slice(0, Math.min(5, keywords.length)).join(', ')];

    await updateResumeSection($, $('.job-details'), keywordGroups, 'for a job experience', fullTailoring);
    await updateResumeSection($, $('.project-details'), keywordGroups, 'for a project', fullTailoring);
    await updateResumeSection($, $('.education-details'), keywordGroups, 'for education', fullTailoring);

    return $.html();
}

async function convertHtmlToPdf(htmlContent) {
    const browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();

    // Inject custom CSS to control page layout and preserve original styles
    const customCSS = `
        @page {
            size: Letter;
            margin: 0.5in;
        }
        body {
            font-family: 'Calibri', 'Arial', sans-serif;
            font-size: 12px;
            line-height: 1.2;
            margin: 0;
            padding: 0;
            color: #333;
        }
    `;

    await page.setContent(htmlContent);
    await page.evaluate((css) => {
        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
    }, customCSS);

    const pdfBuffer = await page.pdf({
        format: 'Letter',
        printBackground: true,
        preferCSSPageSize: true
    });

    await browser.close();
    return pdfBuffer;
}

app.post('/customize-resume', async (req, res) => {
    try {
        const { htmlContent, keywords, fullTailoring } = req.body;
        
        if (!htmlContent || !Array.isArray(keywords)) {
            return res.status(400).send('Invalid input: HTML content and keywords array are required');
        }

        console.log('Received keywords:', keywords);
        console.log('Full tailoring enabled:', fullTailoring);
        
        // Update resume with keywords
        const updatedHtmlContent = await updateResume(htmlContent, keywords, fullTailoring);
        
        // Convert to PDF
        const pdfBuffer = await convertHtmlToPdf(updatedHtmlContent);

        // Send response
        res.contentType('application/pdf');
        res.set('Content-Disposition', 'attachment; filename=customized_resume.pdf');
        res.send(Buffer.from(pdfBuffer));

    } catch (error) {
        console.error('Error processing resume:', error);
        res.status(500).send('Error processing resume: ' + error.message);
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
