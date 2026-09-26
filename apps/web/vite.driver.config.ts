import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';
import {resolve} from 'node:path';

const buildId=process.env.KR_BUILD_ID??new Date().toISOString().replaceAll(/[:.]/g,'-');
export default defineConfig({plugins:[react()],define:{__KR_WEB_BUILD__:JSON.stringify(buildId)},
  build:{outDir:'dist-driver',emptyOutDir:true,sourcemap:false,target:'es2022',rollupOptions:{input:resolve(import.meta.dirname,'driver.html')}}});
