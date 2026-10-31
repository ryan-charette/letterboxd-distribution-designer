/** Colors verified in Letterboxd's official brand SVG and website stylesheet.
 * https://letterboxd.com/about/brand/
 * https://a.ltrbxd.com/logos/letterboxd-decal-dots-neg-rgb.svg
 */
export default {
  content: ['./index.html','./src/**/*.{js,jsx}'],
  theme:{extend:{colors:{
    brand:{50:'#e6fff0',100:'#b3ffd0',200:'#80ffaf',300:'#40ed85',400:'#00e054',500:'#00b343',600:'#008635',700:'#006629',800:'#004d20',900:'#003318',950:'#002010'},
    'brand-orange':'#ff8000', 'brand-blue':'#40bcf4',
    slate:{50:'#ffffff',100:'#ddeeff',200:'#ccddee',300:'#bbccdd',400:'#99aabb',500:'#8899aa',600:'#667788',700:'#445566',800:'#2c3440',900:'#202830',950:'#14181c'},
  }}},plugins:[],
};
