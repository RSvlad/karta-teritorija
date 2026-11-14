import { render } from 'preact';
import { App } from './App';
import { initPrefs } from './prefs';
import '@fontsource-variable/literata/wght.css';
import '@fontsource-variable/source-sans-3/wght.css';
import './styles.css';

initPrefs();
render(<App />, document.getElementById('app')!);
