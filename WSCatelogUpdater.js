/**
 * WSCatelogUpdater.js  (v1.0)
 *
 * Script created and maintained by Manoj Karingamadathil, Malayalam Wikisource Community
 * as part of Grandham Project & Wiki Librarians Network.
 *
 * What it does (on Wikimedia Commons file pages), as TWO SEPARATE EDITS per file:
 *   Edit 1  Wikidata template : adds {{Book |Wikidata = Qxxx}} under "== {{int:filedesc}} =="
 *   Edit 2  Depicts           : adds Structured data "depicts" (P180) = Qxxx, with a reference
 *                               (P854 reference URL = dataset link, P1476 title = dataset name)
 *
 * Edit summary (both edits):
 *   Edited by WSCatelogUpdater via <dataset name> (<dataset link>)
 *
 * Data is NOT inside this script. It is loaded from a separate JSON file (WSCatelogData.json),
 * stored as a Commons user subpage, or loaded from your computer with the "Load data file" button.
 *
 * Install:
 *   1. Save this script as  User:YOURNAME/WSCatelogUpdater.js
 *   2. Save the data file as User:YOURNAME/WSCatelogData.json  (paste the JSON content)
 *   3. Add to User:YOURNAME/common.js :
 *        mw.loader.load( '/w/index.php?title=User:YOURNAME/WSCatelogUpdater.js&action=raw&ctype=text/javascript' );
 *   Optional settings (put BEFORE the line above):
 *        window.WSCatelogUpdaterConfig = { dataPage: 'User:YOURNAME/WSCatelogData.json', delayMs: 2000 };
 */
( function () {
	'use strict';
	if ( mw.config.get( 'wgServerName' ) !== 'commons.wikimedia.org' || !mw.config.get( 'wgUserName' ) ) { return; }

	var TOOL = 'WSCatelogUpdater';
	var VERSION = '1.0';
	var CREDIT = 'Script created and maintained by Manoj Karingamadathil, Malayalam Wikisource Community ' +
		'as part of Grandham Project & Wiki Librarians Network';
	var cfg = window.WSCatelogUpdaterConfig || {};
	var DATA_PAGE = cfg.dataPage || ( 'User:' + mw.config.get( 'wgUserName' ) + '/WSCatelogData.json' );
	var DELAY_MS = cfg.delayMs || 2000; // pause after every saved edit

	var api = null;
	var items = [];
	var stopFlag = false;
	var batch = false;

	/* ================= helpers ================= */
	function esc( s ) { return mw.html.escape( String( s === null || s === undefined ? '' : s ) ); }
	function sleep( ms ) { return new Promise( function ( r ) { setTimeout( r, ms ); } ); }
	function call( method, params ) {
		return new Promise( function ( resolve, reject ) {
			api[ method ]( params ).then( resolve, function ( code, result ) {
				var info = result && result.error && result.error.info;
				reject( new Error( code + ( info ? ' - ' + info : '' ) ) );
			} );
		} );
	}
	function summaryFor( it ) {
		return 'Edited by ' + TOOL + ' via ' + it.datasetName + ' (' + it.datasetLink + ')';
	}

	/* ================= pure logic: wikitext ================= */
	// <pure>
	function maskHidden( text ) {
		// hide comments and <nowiki> so a commented-out {{Book}} is not found (same length -> same indexes)
		return text.replace( /<!--[\s\S]*?-->|<nowiki>[\s\S]*?<\/nowiki>/gi, function ( c ) { return c.replace( /[^\n]/g, ' ' ); } );
	}

	function findTemplate( masked ) {
		var m = /\{\{\s*Book\s*(?=[|}])/i.exec( masked );
		if ( !m ) { return null; }
		var depth = 0, i = m.index, two;
		while ( i < masked.length ) {
			two = masked.substr( i, 2 );
			if ( two === '{{' ) { depth++; i += 2; }
			else if ( two === '}}' ) { depth--; i += 2; if ( depth === 0 ) { return { start: m.index, end: i }; } }
			else { i++; }
		}
		return null;
	}

	// top-level parameters of one template block: [{from, to}] (indexes inside the block)
	function parseParams( blk ) {
		var params = [], depth = 0, i = 0, start = -1, two;
		while ( i < blk.length ) {
			two = blk.substr( i, 2 );
			if ( two === '{{' || two === '[[' ) { depth++; i += 2; continue; }
			if ( two === '}}' || two === ']]' ) {
				depth--;
				if ( depth === 0 ) { if ( start >= 0 ) { params.push( { from: start, to: i } ); } break; }
				i += 2; continue;
			}
			if ( blk.charAt( i ) === '|' && depth === 1 ) {
				if ( start >= 0 ) { params.push( { from: start, to: i } ); }
				start = i + 1;
			}
			i++;
		}
		return params;
	}

	// returns { s: 'ok'|'needs'|'conflict', cur: 'text shown to user', newText: '...' }
	function analyzeTemplate( text, qid ) {
		var masked = maskHidden( text );
		var t = findTemplate( masked );
		if ( !t ) {
			var block = '{{Book\n |Wikidata = ' + qid + '\n}}';
			var hm = /^==[ \t]*\{\{\s*int:filedesc\s*\}\}[ \t]*==[ \t]*$/mi.exec( masked );
			var nt = hm ?
				text.slice( 0, hm.index + hm[ 0 ].length ) + '\n' + block + text.slice( hm.index + hm[ 0 ].length ) :
				'== {{int:filedesc}} ==\n' + block + '\n' + text;
			return { s: 'needs', cur: 'No {{Book}} template', newText: nt };
		}
		var found = null;
		parseParams( masked.slice( t.start, t.end ) ).forEach( function ( p ) {
			var seg = text.slice( t.start + p.from, t.start + p.to );
			var eq = seg.indexOf( '=' );
			if ( !found && eq > 0 && seg.slice( 0, eq ).trim().toLowerCase() === 'wikidata' ) {
				found = {
					vFrom: t.start + p.from + eq + 1,
					vTo: t.start + p.to,
					value: seg.slice( eq + 1 ).trim(),
					trail: /\s*$/.exec( seg )[ 0 ]
				};
			}
		} );
		if ( found ) {
			if ( found.value.toUpperCase() === qid ) { return { s: 'ok', cur: 'Wikidata = ' + qid }; }
			var nt2 = text.slice( 0, found.vFrom ) + ' ' + qid + found.trail + text.slice( found.vTo );
			if ( found.value ) { return { s: 'conflict', cur: 'Wikidata = ' + found.value, newText: nt2 }; }
			return { s: 'needs', cur: '{{Book}} has an empty Wikidata field', newText: nt2 };
		}
		var inner = text.slice( t.start, t.end - 2 ).replace( /\s+$/, '' );
		return {
			s: 'needs', cur: '{{Book}} has no Wikidata field',
			newText: text.slice( 0, t.start ) + inner + '\n |Wikidata = ' + qid + '\n}}' + text.slice( t.end )
		};
	}

	/* ================= pure logic: structured data ================= */
	function hasRef( claim, link ) {
		return ( claim.references || [] ).some( function ( r ) {
			return ( ( r.snaks || {} ).P854 || [] ).some( function ( s ) { return s.datavalue && s.datavalue.value === link; } );
		} );
	}

	// claims = list of P180 statements -> { s: 'ok'|'noref'|'needs', cur, ids, claimId }
	function analyzeDepicts( claims, it ) {
		var ids = [], match = null;
		claims.forEach( function ( c ) {
			var dv = c.mainsnak && c.mainsnak.datavalue;
			if ( !dv || !dv.value || !dv.value.id ) { return; }
			if ( ids.indexOf( dv.value.id ) < 0 ) { ids.push( dv.value.id ); }
			if ( dv.value.id === it.qid && ( !match || ( !hasRef( match, it.datasetLink ) && hasRef( c, it.datasetLink ) ) ) ) { match = c; }
		} );
		var list = 'P180: ' + ( ids.length ? ids.join( ', ' ) : 'none' );
		if ( match && hasRef( match, it.datasetLink ) ) { return { s: 'ok', cur: list + ' (reference present)', ids: ids }; }
		if ( match ) { return { s: 'noref', cur: list + ' (no reference)', ids: ids, claimId: match.id }; }
		return { s: 'needs', cur: list, ids: ids };
	}
	// </pure>

	function refSnaks( it ) {
		return {
			P854: [ { snaktype: 'value', property: 'P854', datavalue: { type: 'string', value: it.datasetLink } } ],
			P1476: [ { snaktype: 'value', property: 'P1476', datavalue: { type: 'monolingualtext', value: { text: it.datasetName, language: 'en' } } } ]
		};
	}
	function newClaim( it ) {
		return {
			mainsnak: {
				snaktype: 'value', property: 'P180',
				datavalue: { type: 'wikibase-entityid', value: { 'entity-type': 'item', 'numeric-id': parseInt( it.qid.slice( 1 ), 10 ) } }
			},
			type: 'statement', rank: 'normal',
			references: [ { snaks: refSnaks( it ), 'snaks-order': [ 'P854', 'P1476' ] } ]
		};
	}

	/* ================= API ================= */
	async function fetchPage( file ) {
		var r = await call( 'get', {
			action: 'query', titles: 'File:' + file, prop: 'revisions', rvprop: 'content|timestamp',
			rvslots: 'main', formatversion: 2
		} );
		var p = r.query.pages[ 0 ];
		if ( p.missing || p.invalid ) { return null; }
		return { pageid: p.pageid, text: p.revisions[ 0 ].slots.main.content, ts: p.revisions[ 0 ].timestamp };
	}

	async function fetchP180( pageid ) {
		var mid = 'M' + pageid;
		try {
			var r = await call( 'get', { action: 'wbgetentities', ids: mid, props: 'claims', formatversion: 2 } );
			var ent = ( r.entities && r.entities[ mid ] ) || {};
			var st = ent.statements || ent.claims || {};
			if ( Array.isArray( st ) ) { st = {}; }
			return st.P180 || [];
		} catch ( e ) {
			if ( /no-such-entity|missing/i.test( e.message ) ) { return []; }
			throw e;
		}
	}

	async function loadDataPage() {
		var r = await call( 'get', {
			action: 'query', titles: DATA_PAGE, prop: 'revisions', rvprop: 'content', rvslots: 'main', formatversion: 2
		} );
		var p = r.query.pages[ 0 ];
		if ( p.missing || p.invalid ) { throw new Error( 'Data page not found: ' + DATA_PAGE ); }
		return JSON.parse( p.revisions[ 0 ].slots.main.content );
	}

	/* ================= state, check, update ================= */
	var CLS = {
		pending: 'wsu-pending', loading: 'wsu-busy', updating: 'wsu-busy', ok: 'wsu-ok', done: 'wsu-ok',
		needs: 'wsu-needs', noref: 'wsu-warn', conflict: 'wsu-bad', missing: 'wsu-bad', error: 'wsu-bad'
	};
	var ICON = {
		pending: '\u2022', loading: '\u231B', updating: '\u231B', ok: '\u2714', done: '\u2714',
		needs: '\u25CF', noref: '\u25B2', conflict: '\u2716', missing: '\u2716', error: '\u2716'
	};
	var LABEL = {
		pending: 'Not checked', loading: 'Checking\u2026', updating: 'Saving\u2026', ok: 'Up to date', done: 'Updated',
		needs: 'Needs update', noref: 'Reference missing', conflict: 'Different value', missing: 'File not found', error: 'Error'
	};

	function overall( it ) {
		var st = [ it.t.s, it.d.s ];
		function any( list ) { return st.some( function ( x ) { return list.indexOf( x ) >= 0; } ); }
		if ( any( [ 'loading', 'updating' ] ) ) { return 'busy'; }
		if ( any( [ 'conflict', 'missing', 'error' ] ) ) { return 'bad'; }
		if ( any( [ 'needs', 'noref' ] ) ) { return 'needs'; }
		if ( st.every( function ( x ) { return x === 'ok' || x === 'done'; } ) ) { return 'ok'; }
		return 'pending';
	}

	async function checkItem( it ) {
		it.t = { s: 'loading', cur: '' };
		it.d = { s: 'loading', cur: '' };
		render( it );
		try {
			var page = await fetchPage( it.file );
			if ( !page ) {
				it.t = { s: 'missing', cur: 'This file does not exist on Commons' };
				it.d = { s: 'missing', cur: 'This file does not exist on Commons' };
				return;
			}
			it.pageid = page.pageid;
			it.t = analyzeTemplate( page.text, it.qid );
			it.d = { s: 'loading', cur: '' };
			render( it );
			it.d = analyzeDepicts( await fetchP180( page.pageid ), it );
		} catch ( e ) {
			if ( it.t.s === 'loading' ) { it.t = { s: 'error', cur: e.message }; }
			it.d = { s: 'error', cur: e.message };
		} finally {
			render( it );
			updateCounts();
		}
	}

	// returns 'edited' | 'unchanged' | 'failed'
	async function updateTemplate( it, force ) {
		it.t = { s: 'updating', cur: '' };
		render( it );
		try {
			var page = await fetchPage( it.file );
			if ( !page ) {
				it.t = { s: 'missing', cur: 'This file does not exist on Commons' };
				return 'failed';
			}
			var res = analyzeTemplate( page.text, it.qid );
			if ( res.s === 'ok' || ( res.s === 'conflict' && !force ) ) { it.t = res; return 'unchanged'; }
			await call( 'postWithEditToken', {
				action: 'edit', title: 'File:' + it.file, text: res.newText, nocreate: 1,
				basetimestamp: page.ts, summary: summaryFor( it )
			} );
			it.t = { s: 'done', cur: 'Wikidata = ' + it.qid };
			return 'edited';
		} catch ( e ) {
			it.t = { s: 'error', cur: e.message };
			return 'failed';
		} finally {
			render( it );
			updateCounts();
		}
	}

	async function updateDepicts( it ) {
		it.d = { s: 'updating', cur: '' };
		render( it );
		try {
			if ( !it.pageid ) {
				var page = await fetchPage( it.file );
				if ( !page ) { it.d = { s: 'missing', cur: 'This file does not exist on Commons' }; return 'failed'; }
				it.pageid = page.pageid;
			}
			var res = analyzeDepicts( await fetchP180( it.pageid ), it );
			if ( res.s === 'ok' ) { it.d = res; return 'unchanged'; }
			if ( res.s === 'noref' ) {
				await call( 'postWithEditToken', {
					action: 'wbsetreference', statement: res.claimId, snaks: JSON.stringify( refSnaks( it ) ), summary: summaryFor( it )
				} );
			} else {
				await call( 'postWithEditToken', {
					action: 'wbeditentity', id: 'M' + it.pageid, data: JSON.stringify( { claims: [ newClaim( it ) ] } ),
					summary: summaryFor( it )
				} );
			}
			var ids = res.ids.slice();
			if ( ids.indexOf( it.qid ) < 0 ) { ids.push( it.qid ); }
			it.d = { s: 'done', cur: 'P180: ' + ids.join( ', ' ) + ' (reference present)', ids: ids };
			return 'edited';
		} catch ( e ) {
			it.d = { s: 'error', cur: e.message };
			return 'failed';
		} finally {
			render( it );
			updateCounts();
		}
	}

	/* ================= UI: rendering ================= */
	function paint( $td, base, st, btn ) {
		$td.attr( 'class', base + ' ' + CLS[ st.s ] ).html(
			'<div class="wsu-lbl">' + ICON[ st.s ] + ' ' + LABEL[ st.s ] + '</div>' +
			( st.cur ? '<div class="wsu-cur">' + esc( st.cur ) + '</div>' : '' ) + btn
		);
	}

	function render( it ) {
		if ( !it.$tr ) { return; }
		it.$tr.attr( 'class', 'wsu-r-' + overall( it ) );
		var tb = '', db = '', ab = '';
		if ( it.t.s === 'needs' ) { tb = '<button class="wsu-btn wsu-sm" data-act="tmpl">Update</button>'; }
		if ( it.t.s === 'conflict' ) { tb = '<button class="wsu-btn wsu-sm" data-act="tmplforce">Overwrite</button>'; }
		if ( it.d.s === 'needs' ) { db = '<button class="wsu-btn wsu-sm" data-act="dep">Update</button>'; }
		if ( it.d.s === 'noref' ) { db = '<button class="wsu-btn wsu-sm" data-act="dep">Add reference</button>'; }
		var o = overall( it );
		if ( o === 'pending' ) { ab = '<button class="wsu-btn wsu-sm" data-act="check">Check</button>'; }
		else if ( o !== 'busy' ) {
			if ( it.t.s === 'needs' || it.d.s === 'needs' || it.d.s === 'noref' ) {
				ab += '<button class="wsu-btn wsu-sm wsu-primary" data-act="both">Update both</button> ';
			}
			ab += '<button class="wsu-btn wsu-sm" data-act="check" title="Check again">\u21BB</button>';
		}
		paint( it.$ct, 'wsu-ct', it.t, tb );
		paint( it.$cd, 'wsu-cd', it.d, db );
		it.$ca.html( ab );
	}

	function updateCounts() {
		var c = { ok: 0, needs: 0, bad: 0, pending: 0, busy: 0 };
		items.forEach( function ( it ) { c[ overall( it ) ]++; } );
		var shown = items.filter( visible ).length;
		$( '#wsu-counts' ).html(
			'<span class="wsu-chip wsu-ok">\u2714 ' + c.ok + ' up to date</span>' +
			'<span class="wsu-chip wsu-needs">\u25CF ' + c.needs + ' need update</span>' +
			'<span class="wsu-chip wsu-bad">\u2716 ' + c.bad + ' problems</span>' +
			'<span class="wsu-chip wsu-pending">\u2022 ' + ( c.pending + c.busy ) + ' not checked</span>' +
			'<span class="wsu-chip">Showing ' + shown + ' of ' + items.length + '</span>'
		);
	}

	function setProgress( done, total, label ) {
		var pct = total ? Math.round( done * 100 / total ) : 0;
		$( '#wsu-fill' ).css( 'width', pct + '%' );
		$( '#wsu-ptxt' ).text( label + ( total ? '  \u2014  ' + done + ' / ' + total + ' (' + pct + '%)' : '' ) );
	}
	function setStatus( msg, kind ) {
		$( '#wsu-status' ).attr( 'class', 'wsu-status wsu-st-' + ( kind || 'info' ) ).text( msg );
	}

	function visible( it ) {
		var f = $( '#wsu-filter' ).val() || 'all';
		var q = $.trim( $( '#wsu-q' ).val() || '' ).toLowerCase();
		if ( f !== 'all' ) {
			var o = overall( it );
			if ( f === 'pending' ? ( o !== 'pending' && o !== 'busy' ) : o !== f ) { return false; }
		}
		if ( q && ( it.file + ' ' + it.qid + ' ' + it.title ).toLowerCase().indexOf( q ) < 0 ) { return false; }
		return true;
	}
	function applyFilter() {
		items.forEach( function ( it ) { it.$tr.toggle( visible( it ) ); } );
		updateCounts();
	}

	/* ================= UI: batches ================= */
	function startBatch() {
		batch = true; stopFlag = false;
		$( '#wsu-box' ).addClass( 'wsu-running' );
		$( '#wsu-stop' ).prop( 'disabled', false );
		$( '#wsu-check, #wsu-all' ).prop( 'disabled', true );
	}
	function endBatch() {
		batch = false;
		$( '#wsu-box' ).removeClass( 'wsu-running' );
		$( '#wsu-stop' ).prop( 'disabled', true );
		$( '#wsu-check, #wsu-all' ).prop( 'disabled', false );
		applyFilter();
	}

	// items are loaded one by one, with progress
	async function checkList( list ) {
		if ( batch || !list.length ) { return; }
		startBatch();
		var i = 0, n = list.length;
		for ( ; i < n && !stopFlag; i++ ) {
			setProgress( i, n, 'Loading ' + list[ i ].file );
			await checkItem( list[ i ] );
		}
		setProgress( i, n, stopFlag ? 'Stopped' : 'All items loaded' );
		setStatus( stopFlag ? 'Stopped after ' + i + ' of ' + n + ' items.' : 'Loaded the current data of ' + n + ' items.', stopFlag ? 'warn' : 'ok' );
		endBatch();
	}

	async function runUpdateAll() {
		if ( batch ) { return; }
		var mode = $( '#wsu-mode' ).val();
		var list = items.filter( visible ).filter( function ( it ) {
			var t = mode !== 'dep' && [ 'pending', 'needs', 'error' ].indexOf( it.t.s ) >= 0;
			var d = mode !== 'tmpl' && [ 'pending', 'needs', 'noref', 'error' ].indexOf( it.d.s ) >= 0;
			return t || d;
		} );
		if ( !list.length ) { setStatus( 'Nothing to update in the current view.', 'info' ); return; }
		var what = { both: 'Wikidata template + depicts (2 separate edits per file)', tmpl: 'Wikidata template only', dep: 'depicts (P180) only' }[ mode ];
		if ( !window.confirm( 'Update ' + list.length + ' file(s)?\n\n' + what +
			'\n\nFiles not yet checked are checked first. Up-to-date files and conflicts are skipped.' ) ) { return; }
		startBatch();
		var edits = 0, fails = 0, i = 0, n = list.length, r;
		for ( ; i < n && !stopFlag; i++ ) {
			var it = list[ i ];
			setProgress( i, n, 'Updating ' + it.file );
			if ( [ 'pending', 'error' ].indexOf( it.t.s ) >= 0 || [ 'pending', 'error' ].indexOf( it.d.s ) >= 0 ) { await checkItem( it ); }
			if ( mode !== 'dep' && it.t.s === 'needs' ) {
				r = await updateTemplate( it, false );
				if ( r === 'edited' ) { edits++; await sleep( DELAY_MS ); } else if ( r === 'failed' ) { fails++; }
			}
			if ( stopFlag ) { i++; break; }
			if ( mode !== 'tmpl' && ( it.d.s === 'needs' || it.d.s === 'noref' ) ) {
				r = await updateDepicts( it );
				if ( r === 'edited' ) { edits++; await sleep( DELAY_MS ); } else if ( r === 'failed' ) { fails++; }
			}
		}
		setProgress( i, n, stopFlag ? 'Stopped' : 'Update finished' );
		setStatus( ( stopFlag ? 'Stopped. ' : 'Finished. ' ) + edits + ' edit(s) saved, ' + fails + ' failed.', fails ? 'warn' : 'ok' );
		endBatch();
	}

	async function rowAction( it, act ) {
		if ( batch || it.busy ) { return; }
		it.busy = true;
		var r;
		try {
			if ( act === 'check' ) {
				await checkItem( it );
				setStatus( 'Checked ' + it.file, 'info' );
			} else if ( act === 'tmpl' || act === 'tmplforce' ) {
				if ( act === 'tmplforce' && !window.confirm( it.file + ' already has a different Wikidata value (' + it.t.cur + ').\nReplace it with ' + it.qid + '?' ) ) { return; }
				r = await updateTemplate( it, act === 'tmplforce' );
				setStatus( r === 'edited' ? 'Template updated: ' + it.file : 'Template not changed: ' + it.file, r === 'failed' ? 'bad' : 'ok' );
			} else if ( act === 'dep' ) {
				r = await updateDepicts( it );
				setStatus( r === 'edited' ? 'Depicts updated: ' + it.file : 'Depicts not changed: ' + it.file, r === 'failed' ? 'bad' : 'ok' );
			} else if ( act === 'both' ) {
				var failed = false;
				if ( it.t.s === 'needs' ) {
					r = await updateTemplate( it, false );
					failed = r === 'failed';
					if ( r === 'edited' ) { await sleep( DELAY_MS ); }
				}
				if ( it.d.s === 'needs' || it.d.s === 'noref' ) {
					r = await updateDepicts( it );
					failed = failed || r === 'failed';
				}
				setStatus( ( failed ? 'Finished with errors: ' : 'Both edits done: ' ) + it.file, failed ? 'bad' : 'ok' );
			}
		} finally {
			it.busy = false;
			render( it );
			updateCounts();
		}
	}

	/* ================= UI: panel ================= */
	function addCss() {
		mw.util.addCSS(
			'#wsu-ov{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000}' +
			'#wsu-box{position:absolute;top:2vh;left:50%;transform:translateX(-50%);width:97vw;max-width:1320px;height:96vh;display:flex;flex-direction:column;' +
			'background:var(--background-color-base,#fff);color:var(--color-base,#202122);border:1px solid var(--border-color-base,#a2a9b1);border-radius:4px;' +
			'box-shadow:0 6px 28px rgba(0,0,0,.45);font-size:13px;line-height:1.4}' +
			'#wsu-box .wsu-head{display:flex;align-items:baseline;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border-color-subtle,#c8ccd1)}' +
			'#wsu-box .wsu-head b{font-size:17px}' +
			'#wsu-box .wsu-sub{opacity:.75}' +
			'#wsu-box .wsu-hr{margin-left:auto;display:flex;gap:6px}' +
			'#wsu-box .wsu-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 14px}' +
			'#wsu-box .wsu-sep{width:1px;height:20px;background:var(--border-color-subtle,#c8ccd1)}' +
			'#wsu-box select,#wsu-box input[type=search]{padding:3px 6px;border:1px solid var(--border-color-base,#a2a9b1);border-radius:2px;' +
			'background:var(--background-color-base,#fff);color:inherit}' +
			'#wsu-box input[type=search]{width:240px}' +
			'#wsu-box .wsu-btn{padding:4px 10px;border:1px solid var(--border-color-base,#a2a9b1);border-radius:2px;cursor:pointer;' +
			'background:var(--background-color-interactive-subtle,#f8f9fa);color:inherit;font:inherit}' +
			'#wsu-box .wsu-btn:hover:not(:disabled){border-color:#36c}' +
			'#wsu-box .wsu-btn:disabled{opacity:.45;cursor:default}' +
			'#wsu-box .wsu-btn:focus-visible,#wsu-box select:focus-visible,#wsu-box input:focus-visible{outline:2px solid #36c;outline-offset:1px}' +
			'#wsu-box .wsu-primary{background:#14866d;border-color:#14866d;color:#fff}' +
			'#wsu-box .wsu-primary:hover:not(:disabled){background:#0f6b57;border-color:#0f6b57}' +
			'#wsu-box .wsu-sm{padding:1px 7px;font-size:12px;margin-top:3px}' +
			'#wsu-box .wsu-prog{display:flex;align-items:center;gap:12px;padding:0 14px 6px;flex-wrap:wrap}' +
			'#wsu-box .wsu-pbar{position:relative;flex:1 1 380px;height:22px;border:1px solid var(--border-color-base,#a2a9b1);border-radius:2px;overflow:hidden;' +
			'background:var(--background-color-neutral-subtle,#f8f9fa)}' +
			'#wsu-fill{position:absolute;inset:0 auto 0 0;width:0;background:rgba(54,102,204,.45);transition:width .15s}' +
			'#wsu-ptxt{position:relative;text-align:center;line-height:20px}' +
			'#wsu-counts{display:flex;gap:6px;flex-wrap:wrap}' +
			'#wsu-box .wsu-chip{padding:1px 8px;border-radius:10px;border:1px solid var(--border-color-subtle,#c8ccd1);white-space:nowrap}' +
			'#wsu-box .wsu-status{padding:4px 14px;min-height:22px}' +
			'#wsu-box .wsu-st-ok{color:#0f6b57}#wsu-box .wsu-st-warn{color:#a15c00}#wsu-box .wsu-st-bad{color:#c0322b}' +
			'#wsu-box .wsu-tw{flex:1;overflow:auto;border-top:1px solid var(--border-color-subtle,#c8ccd1);border-bottom:1px solid var(--border-color-subtle,#c8ccd1)}' +
			'#wsu-box table.wsu-t{width:100%;border-collapse:collapse}' +
			'#wsu-box .wsu-t th{position:sticky;top:0;z-index:1;text-align:left;padding:6px;background:var(--background-color-neutral,#eaecf0)}' +
			'#wsu-box .wsu-t td{padding:5px 6px;vertical-align:top;border-bottom:1px solid var(--border-color-subtle,#c8ccd1)}' +
			'#wsu-box .wsu-n{width:34px;opacity:.7}' +
			'#wsu-box .wsu-f{width:24%;word-break:break-word}' +
			'#wsu-box .wsu-q{width:16%}' +
			'#wsu-box .wsu-ti{font-size:12px;opacity:.75;max-width:230px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
			'#wsu-box .wsu-ca{width:150px}' +
			'#wsu-box .wsu-lbl{font-weight:bold}' +
			'#wsu-box .wsu-cur{font-size:12px;word-break:break-word}' +
			'#wsu-box .wsu-ok{background:rgba(20,134,109,.20)}' +
			'#wsu-box .wsu-needs{background:rgba(255,140,0,.24)}' +
			'#wsu-box .wsu-warn{background:rgba(250,204,21,.30)}' +
			'#wsu-box .wsu-bad{background:rgba(221,51,51,.22)}' +
			'#wsu-box .wsu-busy{background:rgba(54,102,204,.22)}' +
			'#wsu-box .wsu-pending{background:rgba(128,128,128,.14)}' +
			'#wsu-box tr.wsu-r-ok td:first-child{box-shadow:inset 4px 0 #14866d}' +
			'#wsu-box tr.wsu-r-needs td:first-child{box-shadow:inset 4px 0 #ff8c00}' +
			'#wsu-box tr.wsu-r-bad td:first-child{box-shadow:inset 4px 0 #dd3333}' +
			'#wsu-box tr.wsu-r-busy td:first-child{box-shadow:inset 4px 0 #36c}' +
			'#wsu-box.wsu-running .wsu-t button{pointer-events:none;opacity:.45}' +
			'#wsu-box .wsu-legend{display:flex;gap:8px;flex-wrap:wrap;padding:6px 14px}' +
			'#wsu-box .wsu-foot{padding:6px 14px 10px;font-size:12px;opacity:.8}'
		);
	}

	function buildRows() {
		var html = items.map( function ( it, i ) {
			return '<tr data-i="' + i + '" class="wsu-r-pending"><td class="wsu-n">' + ( i + 1 ) + '</td>' +
				'<td class="wsu-f"><a href="' + esc( mw.util.getUrl( 'File:' + it.file ) ) + '" target="_blank" rel="noopener">' + esc( it.file ) + '</a></td>' +
				'<td class="wsu-q"><a href="https://www.wikidata.org/wiki/' + it.qid + '" target="_blank" rel="noopener">' + it.qid + '</a>' +
				'<div class="wsu-ti" title="' + esc( it.title ) + '">' + esc( it.title ) + '</div></td>' +
				'<td class="wsu-ct"></td><td class="wsu-cd"></td><td class="wsu-ca"></td></tr>';
		} ).join( '' );
		$( '#wsu-body' ).html( html );
		var $trs = $( '#wsu-body' ).children();
		items.forEach( function ( it, i ) {
			it.$tr = $trs.eq( i );
			it.$ct = it.$tr.find( '.wsu-ct' );
			it.$cd = it.$tr.find( '.wsu-cd' );
			it.$ca = it.$tr.find( '.wsu-ca' );
			render( it );
		} );
	}

	function setData( obj, origin ) {
		var def = obj.dataset || {}, bad = 0, seen = {}, out = [];
		( obj.items || [] ).forEach( function ( r ) {
			var file = String( r.file || '' ).replace( /^File:/i, '' ).replace( /_/g, ' ' ).trim();
			var qid = String( r.qid || '' ).trim().toUpperCase();
			var name = r.datasetName || def.name, link = r.datasetLink || def.link;
			if ( !file || !/^Q\d+$/.test( qid ) || !name || !link || seen[ file ] ) { bad++; return; }
			seen[ file ] = true;
			out.push( {
				file: file, qid: qid, title: r.title || '', datasetName: name, datasetLink: link,
				t: { s: 'pending', cur: '' }, d: { s: 'pending', cur: '' }
			} );
		} );
		items = out;
		var names = {};
		items.forEach( function ( it ) { names[ it.datasetName ] = true; } );
		$( '#wsu-ds' ).text( Object.keys( names ).join( '; ' ) );
		buildRows();
		updateCounts();
		setProgress( 0, 0, 'Ready' );
		setStatus( 'Loaded ' + items.length + ' files from ' + origin + ( bad ? ' (' + bad + ' invalid or duplicate rows skipped)' : '' ) + '.', bad ? 'warn' : 'ok' );
		checkList( items );
	}

	function openPanel() {
		if ( $( '#wsu-ov' ).length ) { return; }
		api = api || new mw.Api( { userAgent: TOOL + '/' + VERSION + ' (userscript on Commons)' } );
		$( document.body ).append(
			'<div id="wsu-ov"><div id="wsu-box" role="dialog" aria-label="' + TOOL + '">' +
			'<div class="wsu-head"><b>' + TOOL + '</b><span class="wsu-sub">v' + VERSION + '</span><span class="wsu-sub" id="wsu-ds"></span>' +
			'<span class="wsu-hr"><button class="wsu-btn" id="wsu-load">Load data file\u2026</button>' +
			'<button class="wsu-btn" id="wsu-x">Close</button></span></div>' +
			'<div class="wsu-bar">' +
			'<button class="wsu-btn" id="wsu-check">Check items in view</button>' +
			'<button class="wsu-btn" id="wsu-stop" disabled>Stop</button><span class="wsu-sep"></span>' +
			'<select id="wsu-mode" aria-label="Edits to run"><option value="both">Both edits (template, then depicts)</option>' +
			'<option value="tmpl">Wikidata template only</option><option value="dep">Depicts (P180) only</option></select>' +
			'<button class="wsu-btn wsu-primary" id="wsu-all">Update all in view</button><span class="wsu-sep"></span>' +
			'<select id="wsu-filter" aria-label="Filter"><option value="all">Show all</option><option value="needs">Needs update</option>' +
			'<option value="ok">Up to date</option><option value="bad">Problems</option><option value="pending">Not checked</option></select>' +
			'<input type="search" id="wsu-q" placeholder="Search file, Qid or title" aria-label="Search">' +
			'<input type="file" id="wsu-file" accept=".json,application/json" style="display:none"></div>' +
			'<div class="wsu-prog"><div class="wsu-pbar"><div id="wsu-fill"></div><div id="wsu-ptxt">Starting\u2026</div></div>' +
			'<div id="wsu-counts"></div></div>' +
			'<div class="wsu-status wsu-st-info" id="wsu-status"></div>' +
			'<div class="wsu-tw"><table class="wsu-t"><thead><tr><th>#</th><th>File on Commons</th><th>Wikidata item (target)</th>' +
			'<th>{{Book}} Wikidata \u2013 current</th><th>Depicts (P180) \u2013 current</th><th>Action</th></tr></thead>' +
			'<tbody id="wsu-body"></tbody></table></div>' +
			'<div class="wsu-legend"><span class="wsu-chip wsu-ok">\u2714 Up to date / updated</span><span class="wsu-chip wsu-needs">\u25CF Needs update</span>' +
			'<span class="wsu-chip wsu-warn">\u25B2 Reference missing</span><span class="wsu-chip wsu-bad">\u2716 Different value, error or file not found</span>' +
			'<span class="wsu-chip wsu-busy">\u231B Working</span><span class="wsu-chip wsu-pending">\u2022 Not checked</span></div>' +
			'<div class="wsu-foot">Edit summary: <i>Edited by ' + TOOL + ' via (dataset name) ((dataset link))</i>. ' + esc( CREDIT ) + '.</div>' +
			'</div></div>'
		);

		$( '#wsu-x' ).on( 'click', function () { stopFlag = true; $( '#wsu-ov' ).remove(); } );
		$( '#wsu-stop' ).on( 'click', function () { stopFlag = true; setStatus( 'Stopping after the current item\u2026', 'warn' ); } );
		$( '#wsu-check' ).on( 'click', function () { checkList( items.filter( visible ) ); } );
		$( '#wsu-all' ).on( 'click', runUpdateAll );
		$( '#wsu-filter' ).on( 'change', applyFilter );
		$( '#wsu-q' ).on( 'input', applyFilter );
		$( '#wsu-load' ).on( 'click', function () { $( '#wsu-file' ).trigger( 'click' ); } );
		$( '#wsu-file' ).on( 'change', function () {
			var f = this.files && this.files[ 0 ];
			if ( !f || batch ) { return; }
			var rd = new FileReader();
			rd.onload = function () {
				try { setData( JSON.parse( rd.result ), f.name ); } catch ( e ) { setStatus( 'Could not read ' + f.name + ': ' + e.message, 'bad' ); }
			};
			rd.readAsText( f );
		} );
		$( '#wsu-body' ).on( 'click', 'button[data-act]', function () {
			var $b = $( this );
			var it = items[ parseInt( $b.closest( 'tr' ).attr( 'data-i' ), 10 ) ];
			if ( it ) { rowAction( it, $b.attr( 'data-act' ) ); }
		} );

		setProgress( 0, 0, 'Loading data file' );
		setStatus( 'Loading data from ' + DATA_PAGE + ' \u2026', 'info' );
		loadDataPage().then( function ( obj ) { setData( obj, DATA_PAGE ); }, function ( e ) {
			setProgress( 0, 0, 'No data' );
			setStatus( e.message + '. Save the data file there, or use "Load data file\u2026" to pick WSCatelogData.json from your computer.', 'bad' );
		} );
	}

	mw.loader.using( [ 'mediawiki.api', 'mediawiki.util' ] ).then( function () {
		addCss();
		$( function () {
			var li = mw.util.addPortletLink( 'p-tb', '#', TOOL, 't-wsu', 'Add {{Book}} Wikidata and depicts (P180) from the catalog data file' );
			if ( li ) { $( li ).on( 'click', function ( e ) { e.preventDefault(); openPanel(); } ); }
		} );
	} );
}() );
