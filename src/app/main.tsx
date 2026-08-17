import { render } from 'preact';
import { App } from './App.tsx';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Rotyl: #root is missing from the document');

render(<App />, root);
