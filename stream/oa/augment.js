
var through = require('through2'),
    polyline = require('polyline'),
    project = require('../../lib/project'),
    analyze = require('../../lib/analyze'),
    interpolate = require('../../lib/interpolate');

// polyline precision
var PRECISION = 6;

/**
  this stream performs all the interpolation math for a road segment and pushes
  downstream rows to be inserted in the 'street_address' table.
**/
function streamFactory(db, done){

  // create a new stream
  return through.obj(function( lookup, _, next ){

    // store an array of housenumbers and their distance along the linestring
    // per linestring
    var distances = [];

    // decode polylines
    lookup.streets.forEach( function( street, i ){
      street.coordinates = project.dedupe( polyline.toGeoJSON(street.line, PRECISION).coordinates );
      distances[i] = []; // init array
    });

    // process all house number entries in batch
    lookup.batch.forEach( function( item ){

      // parse housenumber
      var housenumber = analyze.housenumber( item.NUMBER );

      // invalid / unusual housenumber
      if( isNaN( housenumber ) ){
        console.error( 'could not reliably parse housenumber', item.NUMBER );
        return;
      }

      // project point on to line string
      var point = [ parseFloat(item.LON), parseFloat(item.LAT) ];

      // pick correct street to use (in case of multiple matches)
      var nearest = { projection: { dist: Infinity }, street: undefined };

      lookup.streets.forEach( function( street, i ){
        var proj = project.pointOnLine( street.coordinates, point );

        // validate projection
        if( !proj || !proj.edge || !proj.point || proj.dist === Infinity ){
          console.error( 'unable to project point on to linestring' );
          console.error( 'street', street );
          console.error( 'point', point );
          return;
        }

        // check if this is the nearest projection
        if( proj.dist < nearest.projection.dist ){
          nearest.projection = proj;
          nearest.street = street;
          nearest.index = i;
        }
      });

      // ensure we have a valid street match
      if( !nearest.street || nearest.projection.dist === Infinity ){
        console.error( 'unable to find nearest street for point' );
        console.error( 'streets', lookup.streets );
        console.error( 'item', item );
        return;
      }

      // compute L/R parity of house on street
      var parity = project.parity( nearest.projection, point );

      // compute the distance along the linestring to the projected point
      var dist = project.lineDistance( project.sliceLineAtProjection( nearest.street.coordinates, nearest.projection ) );
      distances[nearest.index].push({ housenumber: housenumber, dist: dist, parity: parity });

      // push openaddresses values to db
      this.push({
        $id: nearest.street.id,
        $source: 'OA',
        $housenumber: housenumber,
        $lon: point[0].toFixed(7),
        $lat: point[1].toFixed(7),
        $parity: parity,
        $proj_lon: nearest.projection.point[0].toFixed(7),
        $proj_lat: nearest.projection.point[1].toFixed(7)
      });

    }, this);

    // ensure distances are sorted by distance ascending
    // this is important because now the distances and coordinates
    // arrays will run from the start of the street to the end.
    distances.forEach( function( d ){
      d.sort( function( a, b ){
        return ( a.dist > b.dist ) ? 1 : -1;
      });
    });

    /**
      compute the scheme (zig-zag vs. updown) of each road based on
      the house number parity.
      @see: https://en.wikipedia.org/wiki/House_numbering

      zigzag: 1   3   5   7   9
              └─┬─┴─┬─┴─┬─┴─┬─┘
                2   4   5   8

      updown: 1   2   3   4   5
              └─┬─┴─┬─┴─┬─┴─┬─┘
                9   8   7   6
    **/
    distances.forEach( function( d, i ){

      // store a memo of where the odd/even values lie
      var ord = {
        R: { odd: 0, even: 0, total: 0 },
        L: { odd: 0, even: 0, total: 0 }
      };

      // iterate distances to enumerate odd/even on L/R
      d.forEach( function( cur ){
        if( cur.parity && cur.housenumber ){
          var isEven = parseInt( cur.housenumber, 10 ) %2;
          if( isEven ){ ord[cur.parity].even++; }
          else { ord[cur.parity].odd++; }
          ord[cur.parity].total++;
        }
      });

      // zigzag schemes
      var zz1 = ( ord.R.odd === ord.R.total && ord.L.even === ord.L.total ),
          zz2 = ( ord.L.odd === ord.L.total && ord.R.even === ord.R.total );

      // assign correct scheme to street
      lookup.streets[i].scheme = ( zz1 || zz2 ) ? 'zigzag' : 'updown';
    });

    // loop over all linestrings
    lookup.streets.forEach( function( street, si ){

      // distance travelled along the line string
      var vertexDistance = 0;

      // insert each point on linestring in table
      // note: this allows us to ignore the linestring and simply linearly
      // interpolation between matched values at query time.
      street.coordinates.forEach( function( vertex, i ){

        // not a line, just a single point;
        if( 0 === i ){ return; }

        // distance along line to this vertex
        var edge = street.coordinates.slice(i-1, i+1);
        if( edge.length === 2 ){
          vertexDistance += project.lineDistance( edge );
        } // else should not have else!

        // projected fractional housenumber(s)
        var housenumbers = [];

        // zigzag interpolation
        // (one vertex interpolation produced)
        if( street.scheme === 'zigzag' ){
          housenumbers.push( interpolate( distances[si], vertexDistance ) );
        }
        // updown interpolation
        // (two vertex interpolations produced)
        else {
          // left side
          housenumbers.push( interpolate( distances[si].filter( function( d ){
            return d.parity === 'L';
          }), vertexDistance ) );

          // right side
          housenumbers.push( interpolate( distances[si].filter( function( d ){
            return d.parity === 'R';
          }), vertexDistance ) );
        }

        // insert point values in db
        housenumbers.forEach( function( num ){
          if( !num ){ return; } // skip null interpolations
          this.push({
            $id: street.id,
            $source: 'VERTEX',
            $housenumber: num.toFixed(3),
            $lon: undefined,
            $lat: undefined,
            $parity: undefined,
            $proj_lon: vertex[0].toFixed(7),
            $proj_lat: vertex[1].toFixed(7)
          });
        }, this);

      }, this);
    }, this);

    next();
  });
}

module.exports = streamFactory;
