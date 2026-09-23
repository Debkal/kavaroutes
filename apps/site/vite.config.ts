import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({plugins:[react()],server:{host:'127.0.0.1',port:4313,strictPort:true,
  proxy:{'/api':{target:'http://127.0.0.1:58110',changeOrigin:false}}},
  build:{target:'es2022',sourcemap:false}});
