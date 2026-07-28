import Head from '@docusaurus/Head'
import SearchPage from '@theme-original/SearchPage'
import type {ReactNode} from 'react'

export default function SearchPageWithRobotsMeta(): ReactNode {
  return (
    <>
      <Head>
        <meta name="robots" content="noindex, follow" />
      </Head>
      <SearchPage />
    </>
  )
}
