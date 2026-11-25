const fs = require('fs');
const path = require('path');

function tokenize(text) {
    return text
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9ñ\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 1);
}

class BM25Ranker {
    constructor(lyricsDir, k1 = 1.5, b = 0.75) {
        this.lyricsDir = lyricsDir;
        this.k1 = k1;
        this.b = b;
        this.docs = [];
        this.docFreq = new Map();
        this.avgdl = 0;
        this.buildIndex();
    }

    buildIndex() {
        this.docs = [];
        this.docFreq.clear();
        if (!fs.existsSync(this.lyricsDir)) return;

        const files = fs.readdirSync(this.lyricsDir).filter(f => f.toLowerCase().endsWith('.txt'));
        let totalLength = 0;

        for (const file of files) {
            const baseName = path.parse(file).name;
            const content = fs.readFileSync(path.join(this.lyricsDir, file), 'utf8');
            const tokens = tokenize(`${baseName} ${content}`);
            const termFreq = new Map();

            for (const token of tokens) {
                termFreq.set(token, (termFreq.get(token) || 0) + 1);
            }

            for (const term of termFreq.keys()) {
                this.docFreq.set(term, (this.docFreq.get(term) || 0) + 1);
            }

            this.docs.push({
                id: baseName,
                length: tokens.length,
                termFreq
            });
            totalLength += tokens.length;
        }

        this.avgdl = this.docs.length > 0 ? totalLength / this.docs.length : 0;
    }

    search(query, topK = 10) {
        const queryTokens = tokenize(query);
        const N = this.docs.length;
        if (N === 0 || queryTokens.length === 0) return [];

        const results = [];

        for (const doc of this.docs) {
            let score = 0;

            for (const term of queryTokens) {
                const n_t = this.docFreq.get(term) || 0;
                if (n_t === 0) continue;

                const idf = Math.log(((N - n_t + 0.5) / (n_t + 0.5)) + 1);
                const tf = doc.termFreq.get(term) || 0;
                const numerator = tf * (this.k1 + 1);
                const denominator = tf + this.k1 * (1 - this.b + this.b * (doc.length / this.avgdl));

                score += idf * (numerator / denominator);
            }

            if (score > 0) {
                results.push({ name: doc.id, score: Number(score.toFixed(4)) });
            }
        }

        return results.sort((a, b) => b.score - a.score).slice(0, topK);
    }
}

module.exports = { BM25Ranker };
