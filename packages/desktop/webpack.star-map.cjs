const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
module.exports = {
  target:'web', mode:'development', devtool:false,
  entry:path.resolve(__dirname,'preview/star-map.tsx'),
  output:{path:path.resolve(__dirname,'star-map-preview-dist'),filename:'main.js',clean:true},
  resolve:{alias:{'react$':require.resolve('react',{paths:[__dirname]}),'react-dom$':require.resolve('react-dom',{paths:[__dirname]}),'react/jsx-runtime$':require.resolve('react/jsx-runtime',{paths:[__dirname]})},extensions:['.tsx','.ts','.jsx','.js'],extensionAlias:{'.js':['.ts','.tsx','.js']}},
  module:{rules:[{test:/\.tsx?$/,loader:'ts-loader',options:{configFile:path.resolve(__dirname,'tsconfig.renderer.json'),transpileOnly:true}},{test:/\.css$/,use:['style-loader','css-loader']}]},
  plugins:[new HtmlWebpackPlugin({title:'北控宏创 · 企业星链图',templateContent:'<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body></body></html>'})],
  performance:{hints:false},
};
