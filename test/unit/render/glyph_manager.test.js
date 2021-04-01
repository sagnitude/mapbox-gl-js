import {test} from '../../util/test.js';
import parseGlyphPBF from '../../../src/style/parse_glyph_pbf.js';
import GlyphManager, {LocalGlyphMode} from '../../../src/render/glyph_manager.js';
import fs from 'fs';

const glyphs = {};
for (const glyph of parseGlyphPBF(fs.readFileSync('./test/fixtures/0-255.pbf'))) {
    glyphs[glyph.id] = glyph;
}

const identityTransform = (url) => ({url});

const TinySDF = class {
    constructor() {
        this.fontWeight = '400';
    }
    // Return empty 30x30 bitmap (24 fontsize + 3 * 2 buffer)
    drawWithMetrics() {
        return {
            alphaChannel: new Uint8ClampedArray(900),
            metrics: {width: 48, height: 48, sdfWidth: 30, sdfHeight: 30, advance: 48}
        };
    }
};

const createLoadGlyphRangeStub = (t) => {
    return t.stub(GlyphManager, 'loadGlyphRange').callsFake((stack, range, urlTemplate, transform, callback) => {
        t.equal(stack, 'Arial Unicode MS');
        t.equal(range, 0);
        t.equal(urlTemplate, 'https://localhost/fonts/v1/{fontstack}/{range}.pbf');
        t.equal(transform, identityTransform);
        setImmediate(() => callback(null, glyphs));
    });
};

const createGlyphManager = (font, allGlyphs) => {
    const manager = new GlyphManager(identityTransform,
        font ? (allGlyphs ? LocalGlyphMode.all : LocalGlyphMode.ideographs) : LocalGlyphMode.none,
        font);
    manager.setURL('https://localhost/fonts/v1/{fontstack}/{range}.pbf');
    return manager;
};

test('GlyphManager requests 0-255 PBF', (t) => {
    createLoadGlyphRangeStub(t);
    const manager = createGlyphManager();

    manager.getGlyphs({'Arial Unicode MS': [55]}, (err, glyphs) => {
        t.ifError(err);
        t.equal(glyphs['Arial Unicode MS']['55'].metrics.advance, 12);
        t.end();
    });
});

test('GlyphManager doesn\'t request twice 0-255 PBF if a glyph is missing', (t) => {
    const stub = createLoadGlyphRangeStub(t);
    const manager = createGlyphManager();

    manager.getGlyphs({'Arial Unicode MS': [0.5]}, (err) => {
        t.ifError(err);
        t.equal(manager.entries['Arial Unicode MS'].ranges[0], true);
        t.equal(stub.calledOnce, true);

        // We remove all requests as in getGlyphs code.
        delete manager.entries['Arial Unicode MS'].requests[0];

        manager.getGlyphs({'Arial Unicode MS': [0.5]}, (err) => {
            t.ifError(err);
            t.equal(manager.entries['Arial Unicode MS'].ranges[0], true);
            t.equal(stub.calledOnce, true);
            t.end();
        });
    });
});

test('GlyphManager requests remote CJK PBF', (t) => {
    t.stub(GlyphManager, 'loadGlyphRange').callsFake((stack, range, urlTemplate, transform, callback) => {
        setImmediate(() => callback(null, glyphs));
    });

    const manager = createGlyphManager();

    manager.getGlyphs({'Arial Unicode MS': [0x5e73]}, (err, glyphs) => {
        t.ifError(err);
        t.equal(glyphs['Arial Unicode MS'][0x5e73], null); // The fixture returns a PBF without the glyph we requested
        t.end();
    });
});

test('GlyphManager does not cache CJK chars that should be rendered locally', (t) => {
    t.stub(GlyphManager, 'loadGlyphRange').callsFake((stack, range, urlTemplate, transform, callback) => {
        const overlappingGlyphs = {};
        const start = range * 256;
        const end = start + 256;
        for (let i = start, j = 0; i < end; i++, j++) {
            overlappingGlyphs[i] = glyphs[j];
        }
        setImmediate(() => callback(null, overlappingGlyphs));
    });
    t.stub(GlyphManager, 'TinySDF').value(TinySDF);
    const manager = createGlyphManager('sans-serif');

    //Request char that overlaps Katakana range
    manager.getGlyphs({'Arial Unicode MS': [0x3005]}, (err, glyphs) => {
        t.ifError(err);
        t.notEqual(glyphs['Arial Unicode MS'][0x3005], null);
        //Request char from Katakana range (te)
        manager.getGlyphs({'Arial Unicode MS': [0x30C6]}, (err, glyphs) => {
            t.ifError(err);
            const glyph = glyphs['Arial Unicode MS'][0x30c6];
            //Ensure that te is locally generated.
            t.equal(glyph.bitmap.height, 30);
            t.equal(glyph.bitmap.width, 30);
            t.end();
        });
    });
});

test('GlyphManager generates CJK PBF locally', (t) => {
    t.stub(GlyphManager, 'TinySDF').value(TinySDF);

    const manager = createGlyphManager('sans-serif');

    manager.getGlyphs({'Arial Unicode MS': [0x5e73]}, (err, glyphs) => {
        t.ifError(err);
        t.equal(glyphs['Arial Unicode MS'][0x5e73].metrics.advance, 24);
        t.end();
    });
});

test('GlyphManager generates Katakana PBF locally', (t) => {
    t.stub(GlyphManager, 'TinySDF').value(TinySDF);

    const manager = createGlyphManager('sans-serif');

    // Katakana letter te
    manager.getGlyphs({'Arial Unicode MS': [0x30c6]}, (err, glyphs) => {
        t.ifError(err);
        t.equal(glyphs['Arial Unicode MS'][0x30c6].metrics.advance, 24);
        t.end();
    });
});

test('GlyphManager generates Hiragana PBF locally', (t) => {
    t.stub(GlyphManager, 'TinySDF').value(TinySDF);

    const manager = createGlyphManager('sans-serif');

    //Hiragana letter te
    manager.getGlyphs({'Arial Unicode MS': [0x3066]}, (err, glyphs) => {
        t.ifError(err);
        t.equal(glyphs['Arial Unicode MS'][0x3066].metrics.advance, 24);
        t.end();
    });
});

test('GlyphManager caches locally generated glyphs', (t) => {
    let drawCallCount = 0;
    t.stub(GlyphManager, 'TinySDF').value(class {
        constructor() {
            this.fontWeight = '400';
        }
        // Return empty 30x30 bitmap (24 fontsize + 3 * 2 buffer)
        drawWithMetrics() {
            drawCallCount++;
            return {
                alphaChannel: new Uint8ClampedArray(900),
                metrics: {width: 48, height: 48, sdfWidth: 30, sdfHeight: 30, advance: 48}
            };
        }
    });

    const manager = createGlyphManager('sans-serif');

    // Katakana letter te
    manager.getGlyphs({'Arial Unicode MS': [0x30c6]}, (err, glyphs) => {
        t.ifError(err);
        t.equal(glyphs['Arial Unicode MS'][0x30c6].metrics.advance, 24);
        manager.getGlyphs({'Arial Unicode MS': [0x30c6]}, () => {
            t.equal(drawCallCount, 1);
            t.end();
        });
    });
});

test('GlyphManager locally generates latin glyphs', (t) => {
    t.stub(GlyphManager, 'TinySDF').value(class {
        constructor() {
            this.fontWeight = '400';
        }
        // Return empty 18x24 bitmap (made up glyph size + 3 * 2 buffer)
        drawWithMetrics() {
            return {
                alphaChannel: new Uint8ClampedArray(480),
                metrics: {width: 28, height: 36, sdfWidth: 20, sdfHeight: 24, advance: 20}
            };
        }
    });

    const manager = createGlyphManager('sans-serif', true);

    manager.getGlyphs({'Arial Unicode MS': ['A']}, (err, glyphs) => {
        t.ifError(err);
        t.equal(glyphs['Arial Unicode MS']['A'].metrics.advance, 10);
        t.equal(glyphs['Arial Unicode MS']['A'].metrics.width, 14);
        t.equal(glyphs['Arial Unicode MS']['A'].metrics.height, 18);
        t.end();
    });
});
