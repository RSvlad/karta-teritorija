import { render } from 'preact';
import { App } from './App';
import { initPrefs } from './prefs';
import './styles.css';

initPrefs();
render(<App />, document.getElementById('app')!);
