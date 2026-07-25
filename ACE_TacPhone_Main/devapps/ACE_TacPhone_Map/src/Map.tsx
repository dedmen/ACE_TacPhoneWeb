import { useState } from 'react'
import styles from './styles.module.css'

function App() {
  const [count, setCount] = useState(0)

  return (
    <>
      <section id="center" className={`${styles.button}`}>
        <div>
          <h1>Get starteds</h1>
          <p>
            Edit <code>src/App.tsx</code> abcdef <code>HMR</code>
          </p>
        </div>
        <button
          type="button"
          className="counter"
          onClick={() => {setCount((count) => count + 1)}}
        >
          Count is {count}
        </button>
      </section>

      <div className="ticks"></div>

      <section id="next-steps">

      </section>

      <div className="ticks"></div>
      <section id="spacer"></section>
    </>
  )
}

export default App
