import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {RouterProvider} from 'react-router';
import {driverRouter} from './driver-router';
import './styles.css';

const root=document.getElementById('root');
if(!root)throw new Error('DRIVER_ROOT_MISSING');
createRoot(root).render(<StrictMode><RouterProvider router={driverRouter}/></StrictMode>);
