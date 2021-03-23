// @flow

import DepthMode from '../gl/depth_mode';
import StencilMode from '../gl/stencil_mode';
import ColorMode from '../gl/color_mode';
import CullFaceMode from '../gl/cull_face_mode';
import EXTENT from '../data/extent';
import {
    fillExtrusionUniformValues,
    fillExtrusionPatternUniformValues,
} from './program/fill_extrusion_program';
import Point from '@mapbox/point-geometry';
import {OverscaledTileID} from '../source/tile_id';
import assert from 'assert';

import type Painter from './painter';
import type SourceCache from '../source/source_cache';
import type FillExtrusionStyleLayer from '../style/style_layer/fill_extrusion_style_layer';
import type FillExtrusionBucket from '../data/bucket/fill_extrusion_bucket';

export default draw;

function draw(painter: Painter, source: SourceCache, layer: FillExtrusionStyleLayer, coords: Array<OverscaledTileID>) {
    const opacity = layer.paint.get('fill-extrusion-opacity');
    if (opacity === 0) {
        return;
    }

    if (painter.renderPass === 'translucent') {
        const depthMode = new DepthMode(painter.context.gl.LEQUAL, DepthMode.ReadWrite, painter.depthRangeFor3D);

        if (opacity === 1 && !layer.paint.get('fill-extrusion-pattern').constantOr((1: any))) {
            const colorMode = painter.colorModeForRenderPass();
            drawExtrusionTiles(painter, source, layer, coords, depthMode, StencilMode.disabled, colorMode);

        } else {
            // Draw transparent buildings in two passes so that only the closest surface is drawn.
            // First draw all the extrusions into only the depth buffer. No colors are drawn.
            drawExtrusionTiles(painter, source, layer, coords, depthMode,
                StencilMode.disabled,
                ColorMode.disabled);

            // Then draw all the extrusions a second type, only coloring fragments if they have the
            // same depth value as the closest fragment in the previous pass. Use the stencil buffer
            // to prevent the second draw in cases where we have coincident polygons.
            drawExtrusionTiles(painter, source, layer, coords, depthMode,
                painter.stencilModeFor3D(),
                painter.colorModeForRenderPass());
        }
    }
}

function drawExtrusionTiles(painter, source, layer, coords, depthMode, stencilMode, colorMode) {
    const context = painter.context;
    const gl = context.gl;
    const patternProperty = layer.paint.get('fill-extrusion-pattern');
    const patternPropertyTop = layer.paint.get('fill-extrusion-top-pattern');
    const image = patternProperty.constantOr((1: any));
    const imageTop = patternPropertyTop.constantOr((1: any));
    const crossfade = layer.getCrossfadeParameters();
    const opacity = layer.paint.get('fill-extrusion-opacity');

    for (const coord of coords) {
        const tile = source.getTile(coord);
        const bucket: ?FillExtrusionBucket = (tile.getBucket(layer): any);
        if (!bucket) continue;

        const programConfiguration = bucket.programConfigurations.get(layer.id);
        const program = painter.useProgram(image ? 'fillExtrusionPattern' : 'fillExtrusion', programConfiguration);

        if (painter.terrain) {
            const terrain = painter.terrain;
            if (!bucket.enableTerrain) continue;
            terrain.setupElevationDraw(tile, program, {useMeterToDem: true});
            flatRoofsUpdate(context, source, coord, bucket, layer, terrain);
            if (!bucket.centroidVertexBuffer) {
                const attrIndex: number | void = program.attributes['a_centroid_pos'];
                if (attrIndex !== undefined) gl.vertexAttrib2f(attrIndex, 0, 0);
            }
        }

        if (image) {
            painter.context.activeTexture.set(gl.TEXTURE0);
            tile.imageAtlasTexture.bind(gl.LINEAR, gl.CLAMP_TO_EDGE);
            programConfiguration.updatePaintBuffers(crossfade);
        }
        const constantPattern = patternProperty.constantOr(null);
        if (constantPattern && tile.imageAtlas) {
            const atlas = tile.imageAtlas;
            const posTo = atlas.patternPositions[constantPattern.to.toString()];
            const posFrom = atlas.patternPositions[constantPattern.from.toString()];
            if (posTo && posFrom) programConfiguration.setConstantPatternPositions(posTo, posFrom);
        }

        if (imageTop) {
            painter.context.activeTexture.set(gl.TEXTURE1);
            tile.imageAtlasTexture2.bind(gl.LINEAR, gl.CLAMP_TO_EDGE);
            programConfiguration.updatePaintBuffers(crossfade);
        }
        const constantPattern2 = patternPropertyTop.constantOr(null);
        if (constantPattern2 && tile.imageAtlas2) {
            const atlas = tile.imageAtlas2;
            const posTo = atlas.patternPositions[constantPattern2.to.toString()];
            const posFrom = atlas.patternPositions[constantPattern2.from.toString()];
            if (posTo && posFrom) programConfiguration.setConstantPatternPositions(posTo, posFrom);
        }

        const matrix = painter.translatePosMatrix(
            coord.posMatrix,
            tile,
            layer.paint.get('fill-extrusion-translate'),
            layer.paint.get('fill-extrusion-translate-anchor'));

        const shouldUseVerticalGradient = layer.paint.get('fill-extrusion-vertical-gradient');
        const uniformValues = image ?
            fillExtrusionPatternUniformValues(matrix, painter, shouldUseVerticalGradient, opacity, coord, crossfade, tile) :
            fillExtrusionUniformValues(matrix, painter, shouldUseVerticalGradient, opacity);

        program.draw(context, context.gl.TRIANGLES, depthMode, stencilMode, colorMode, CullFaceMode.backCCW,
            uniformValues, layer.id, bucket.layoutVertexBuffer, bucket.indexBuffer,
            bucket.segments, layer.paint, painter.transform.zoom,
            programConfiguration, painter.terrain ? bucket.centroidVertexBuffer : null);
    }
}

// Flat roofs array is prepared in the bucket, except for buildings that are on tile borders.
// For them, join pieces, calculate joined size here, and then upload data.
function flatRoofsUpdate(context, source, coord, bucket, layer, terrain) {
    // For all four borders: 0 - left, 1, right, 2 - top, 3 - bottom
    const neighborCoord = [
        coord => {
            let x = coord.canonical.x - 1;
            let w = coord.wrap;
            if (x < 0) {
                x = (1 << coord.canonical.z) - 1;
                w--;
            }
            return new OverscaledTileID(coord.overscaledZ, w, coord.canonical.z, x, coord.canonical.y);
        },
        coord => {
            let x = coord.canonical.x + 1;
            let w = coord.wrap;
            if (x === 1 << coord.canonical.z) {
                x = 0;
                w++;
            }
            return new OverscaledTileID(coord.overscaledZ, w, coord.canonical.z, x, coord.canonical.y);
        },
        coord => new OverscaledTileID(coord.overscaledZ, coord.wrap, coord.canonical.z, coord.canonical.x,
            (coord.canonical.y === 0 ? 1 << coord.canonical.z : coord.canonical.y) - 1),
        coord => new OverscaledTileID(coord.overscaledZ, coord.wrap, coord.canonical.z, coord.canonical.x,
            coord.canonical.y === (1 << coord.canonical.z) - 1 ? 0 : coord.canonical.y + 1)
    ];

    const getLoadedBucket = (nid) => {
        const maxzoom = source.getSource().maxzoom;
        // In overscale range, look one tile zoom above and under. We do this to
        // avoid flickering and use the content in Z-1 and Z+1 buckets until Z bucket is loaded.
        for (const j of [0, -1, 1]) {
            if (nid.overscaledZ + j < maxzoom) continue;
            if (j > 0 && nid.overscaledZ < maxzoom) continue;
            const n = source.getTileByID(nid.calculateScaledKey(nid.overscaledZ + j));
            if (n && n.hasData()) {
                const nBucket: ?FillExtrusionBucket = (n.getBucket(layer): any);
                if (nBucket) return nBucket;
            }
        }
    };

    const projectedToBorder = [0, 0, 0]; // [min, max, maxOffsetFromBorder]
    const xjoin = (a, b) => {
        projectedToBorder[0] = Math.min(a.min.y, b.min.y);
        projectedToBorder[1] = Math.max(a.max.y, b.max.y);
        projectedToBorder[2] = EXTENT - b.min.x > a.max.x ? b.min.x - EXTENT : a.max.x;
        return projectedToBorder;
    };
    const yjoin = (a, b) => {
        projectedToBorder[0] = Math.min(a.min.x, b.min.x);
        projectedToBorder[1] = Math.max(a.max.x, b.max.x);
        projectedToBorder[2] = EXTENT - b.min.y > a.max.y ? b.min.y - EXTENT : a.max.y;
        return projectedToBorder;
    };
    const projectCombinedSpanToBorder = [
        (a, b) => xjoin(a, b),
        (a, b) => xjoin(b, a),
        (a, b) => yjoin(a, b),
        (a, b) => yjoin(b, a)
    ];

    const centroid = new Point(0, 0);
    const error = 3; // Allow intrusion of a building to the building with adjacent wall.

    let demTile, neighborDEMTile, neighborTileID;

    const flatBase = (min, max, edge, verticalEdge, maxOffsetFromBorder) => {
        const points = [[verticalEdge ? edge : min, verticalEdge ? min : edge, 0], [verticalEdge ? edge : max, verticalEdge ? max : edge, 0]];

        const coord3 = maxOffsetFromBorder < 0 ? EXTENT + maxOffsetFromBorder : maxOffsetFromBorder;
        const thirdPoint = [verticalEdge ? coord3 : (min + max) / 2, verticalEdge ? (min + max) / 2 : coord3, 0];
        if ((edge === 0 && maxOffsetFromBorder < 0) || (edge !== 0 && maxOffsetFromBorder > 0)) {
            // Third point is inside neighbor tile, not in the |coord| tile.
            terrain.getForTilePoints(neighborTileID, [thirdPoint], true, neighborDEMTile);
        } else {
            points.push(thirdPoint);
        }
        terrain.getForTilePoints(coord, points, true, demTile);
        return Math.max(points[0][2], points[1][2], thirdPoint[2]) / terrain.exaggeration();
    };

    // Process all four borders: get neighboring tile
    for (let i = 0; i < 4; i++) {
        // Sort by border intersection area minimums, ascending.
        const a = bucket.borders[i];
        if (a.length === 0) { bucket.borderDone[i] = true; }
        if (bucket.borderDone[i]) continue;
        const nid = neighborTileID = neighborCoord[i](coord);
        const nBucket: ?FillExtrusionBucket = getLoadedBucket(nid);
        if (!nBucket || !nBucket.enableTerrain) continue;

        neighborDEMTile = terrain.findDEMTileFor(nid);
        if (!neighborDEMTile || !neighborDEMTile.dem) continue;
        if (!demTile) {
            const dem = terrain.findDEMTileFor(coord);
            if (!(dem && dem.dem)) return; // defer update until an elevation tile is available.
            demTile = dem;
        }
        const j = (i < 2 ? 1 : 5) - i;
        const b = nBucket.borders[j];
        let ib = 0;
        for (let ia = 0; ia < a.length; ia++) {
            const parta = bucket.featuresOnBorder[a[ia]];
            const partABorderRange = parta.borders[i];
            // Find all nBucket parts that share the border overlap.
            let partb;
            while (ib < b.length) {
                // Pass all that are before the overlap.
                partb = nBucket.featuresOnBorder[b[ib]];
                const partBBorderRange = partb.borders[j];
                if (partBBorderRange[1] > partABorderRange[0] + error) break;
                if (!nBucket.borderDone[j]) nBucket.encodeCentroid(undefined, partb, false);
                ib++;
            }
            if (partb && ib < b.length) {
                const saveIb = ib;
                let count = 0;
                while (true) {
                    // Collect all parts overlapping parta on the edge, to make sure it is only one.
                    const partBBorderRange = partb.borders[j];
                    if (partBBorderRange[0] > partABorderRange[1] - error) break;
                    count++;
                    if (++ib === b.length) break;
                    partb = nBucket.featuresOnBorder[b[ib]];
                }
                partb = nBucket.featuresOnBorder[b[saveIb]];

                // If any of a or b crosses more than one tile edge, don't support flat roof.
                if (parta.intersectsCount() > 1 || partb.intersectsCount() > 1 || count !== 1) {
                    if (count !== 1) {
                        ib = saveIb; // rewind unprocessed ib so that it is processed again for the next ia.
                    }

                    bucket.encodeCentroid(undefined, parta, false);
                    if (!nBucket.borderDone[j]) nBucket.encodeCentroid(undefined, partb, false);
                    continue;
                }

                // Now we have 1-1 matching of parts in both tiles that share the edge. Calculate flat base elevation
                // as average of three points: 2 are edge points (combined span projected to border) and one is point of
                // span that has maximum offset to border.
                const span = projectCombinedSpanToBorder[i](parta, partb);
                const edge = (i % 2) ? EXTENT - 1 : 0;
                centroid.x = flatBase(span[0], Math.min(EXTENT - 1, span[1]), edge, i < 2, span[2]);
                centroid.y = 0;
                assert(parta.vertexArrayOffset !== undefined && parta.vertexArrayOffset < bucket.layoutVertexArray.length);
                bucket.encodeCentroid(centroid, parta, false);

                assert(partb.vertexArrayOffset !== undefined && partb.vertexArrayOffset < nBucket.layoutVertexArray.length);
                if (!nBucket.borderDone[j]) nBucket.encodeCentroid(centroid, partb, false);
            } else {
                assert(parta.intersectsCount() > 1 || (partb && partb.intersectsCount() > 1)); // expected at the end of border, when buildings cover corner (show building w/o flat roof).
                bucket.encodeCentroid(undefined, parta, false);
            }
        }

        bucket.borderDone[i] = bucket.needsCentroidUpdate = true;
        if (!nBucket.borderDone[j]) {
            nBucket.borderDone[j] = nBucket.needsCentroidUpdate = true;
        }
    }

    if (bucket.needsCentroidUpdate || (!bucket.centroidVertexBuffer && bucket.centroidVertexArray.length !== 0)) {
        bucket.uploadCentroid(context);
    }
}
